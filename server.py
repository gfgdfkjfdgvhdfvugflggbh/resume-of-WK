#!/usr/bin/env python3
"""向晴简历本地后端：账号、免费额度、订单与权益发放闭环。

默认是 DEMO 模式，不产生真实扣款。生产环境必须接入微信/支付宝官方回调并
设置真实短信与 OAuth 凭证，详见 HANDOFF.md。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    import firebase_admin
    from firebase_admin import auth as firebase_auth
except ImportError:
    firebase_admin = None
    firebase_auth = None

try:
    import jwt
except ImportError:
    jwt = None

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "resume_app.db"


def load_env_file(path: Path) -> None:
    """读取本地 .env；生产环境仍建议使用平台密钥管理。"""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(ROOT / ".env")
DEMO_MODE = os.getenv("DEMO_MODE", "true").lower() == "true"
WEBHOOK_SECRET = os.getenv("PAYMENT_WEBHOOK_SECRET", "")
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")
XIANYU_ITEM_URL = os.getenv("XIANYU_ITEM_URL", "")
XIANYU_ITEM_URLS = {
    "single": os.getenv("XIANYU_SINGLE_URL", "") or XIANYU_ITEM_URL,
    "basic": os.getenv("XIANYU_BASIC_URL", "") or XIANYU_ITEM_URL,
    "pro": os.getenv("XIANYU_PRO_URL", "") or XIANYU_ITEM_URL,
}
DIRECT_PAYMENT_ENABLED = os.getenv("DIRECT_PAYMENT_ENABLED", "false").lower() == "true"
FIREBASE_WEB_CONFIG = {
    "apiKey": os.getenv("FIREBASE_API_KEY", ""),
    "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
    "projectId": os.getenv("FIREBASE_PROJECT_ID", ""),
    "appId": os.getenv("FIREBASE_APP_ID", ""),
    "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
    "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET", ""),
}
FIREBASE_CLIENT_CONFIGURED = all(
    FIREBASE_WEB_CONFIG[key] for key in ("apiKey", "authDomain", "projectId", "appId")
)
FIREBASE_CREDENTIALS_CONFIGURED = bool(
    os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    or os.getenv("FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS", "false").lower() == "true"
)
FIREBASE_ADMIN_READY = False
if FIREBASE_CLIENT_CONFIGURED and FIREBASE_CREDENTIALS_CONFIGURED and firebase_admin:
    try:
        try:
            firebase_admin.get_app()
        except ValueError:
            firebase_admin.initialize_app(options={"projectId": FIREBASE_WEB_CONFIG["projectId"]})
        FIREBASE_ADMIN_READY = True
    except Exception as error:
        print(f"Firebase Admin 初始化失败：{error}")
FIREBASE_PUBLIC_TOKEN_VERIFY_READY = FIREBASE_CLIENT_CONFIGURED and jwt is not None
FIREBASE_AUTH_ENABLED = FIREBASE_CLIENT_CONFIGURED and (
    FIREBASE_ADMIN_READY or FIREBASE_PUBLIC_TOKEN_VERIFY_READY
)
FIREBASE_CERTS_URL = (
    "https://www.googleapis.com/robot/v1/metadata/x509/"
    "securetoken@system.gserviceaccount.com"
)
_firebase_cert_cache: dict[str, str] = {}
_firebase_cert_cache_expires_at = 0
_firebase_cert_lock = threading.Lock()
PLAN_TABLE = {
    "single": {"amount": 2.98, "name": "单次下载"},
    "basic": {"amount": 19.8, "name": "向晴会员"},
    "pro": {"amount": 29.8, "name": "向晴无限会员"},
}
SHANGHAI_TZ = timezone(timedelta(hours=8))


def now() -> int:
    return int(time.time())


def china_date_key() -> str:
    return datetime.now(SHANGHAI_TZ).strftime("%Y-%m-%d")


def china_week_key() -> str:
    current = datetime.now(SHANGHAI_TZ)
    monday = current - timedelta(days=current.weekday())
    return monday.strftime("%Y-%m-%d")


def make_redemption_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(12))
    return f"XQ-{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def admin_secret_valid(headers) -> bool:
    expected = ADMIN_SECRET or ("demo-admin-123456" if DEMO_MODE else "")
    return bool(expected) and secrets.compare_digest(headers.get("X-Admin-Secret", ""), expected)


def firebase_public_certificates() -> dict[str, str]:
    """按 Google 的 Cache-Control 有效期缓存 Firebase ID Token 公钥。"""
    global _firebase_cert_cache, _firebase_cert_cache_expires_at
    if _firebase_cert_cache and _firebase_cert_cache_expires_at > now():
        return _firebase_cert_cache
    with _firebase_cert_lock:
        if _firebase_cert_cache and _firebase_cert_cache_expires_at > now():
            return _firebase_cert_cache
        request = Request(FIREBASE_CERTS_URL, headers={"User-Agent": "resume-of-WK/1.0"})
        with urlopen(request, timeout=10) as response:
            certificates = json.loads(response.read().decode("utf-8"))
            cache_control = response.headers.get("Cache-Control", "")
        match = re.search(r"max-age=(\d+)", cache_control)
        max_age = int(match.group(1)) if match else 3600
        _firebase_cert_cache = certificates
        _firebase_cert_cache_expires_at = now() + max(300, max_age)
        return certificates


def verify_firebase_id_token(id_token: str) -> dict:
    """优先使用 Admin SDK；无服务账号时按 Firebase 规范验证公开签名。"""
    if FIREBASE_ADMIN_READY and firebase_auth:
        return firebase_auth.verify_id_token(id_token)
    if not jwt:
        raise RuntimeError("PYJWT_NOT_INSTALLED")
    header = jwt.get_unverified_header(id_token)
    key_id = str(header.get("kid") or "")
    if header.get("alg") != "RS256" or not key_id:
        raise ValueError("INVALID_FIREBASE_TOKEN_HEADER")
    certificate = firebase_public_certificates().get(key_id)
    if not certificate:
        raise ValueError("UNKNOWN_FIREBASE_SIGNING_KEY")
    project_id = FIREBASE_WEB_CONFIG["projectId"]
    decoded = jwt.decode(
        id_token,
        certificate,
        algorithms=["RS256"],
        audience=project_id,
        issuer=f"https://securetoken.google.com/{project_id}",
        leeway=30,
        options={"require": ["exp", "iat", "aud", "iss", "sub", "auth_time"]},
    )
    subject = str(decoded.get("sub") or "")
    if not subject or len(subject) > 128 or int(decoded.get("auth_time", 0)) > now() + 30:
        raise ValueError("INVALID_FIREBASE_TOKEN_CLAIMS")
    decoded["uid"] = subject
    return decoded


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY, phone TEXT UNIQUE, email TEXT UNIQUE, provider TEXT NOT NULL,
              provider_subject TEXT, free_credits INTEGER NOT NULL DEFAULT 3,
              free_credit_date TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS verification_codes (
              phone TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
              order_no TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan TEXT NOT NULL,
              method TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL,
              provider_transaction_id TEXT UNIQUE, created_at INTEGER NOT NULL,
              paid_at INTEGER, fulfilled_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS entitlements (
              user_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'none',
              credits INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
              usage_date TEXT, usage_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS redemption_codes (
              code TEXT PRIMARY KEY, xianyu_order_no TEXT UNIQUE NOT NULL,
              plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'UNUSED',
              created_at INTEGER NOT NULL, redeemed_by TEXT, redeemed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_subject
              ON users(provider, provider_subject) WHERE provider_subject IS NOT NULL;
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "free_credit_date" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN free_credit_date TEXT")
        if "email" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN email TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL")


def refresh_daily_free_credits(conn: sqlite3.Connection, user_id: str):
    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if user and user["free_credit_date"] != china_date_key():
        conn.execute("UPDATE users SET free_credits=3,free_credit_date=? WHERE id=?", (china_date_key(), user_id))
        user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return user


def row_dict(row):
    return dict(row) if row else None


def create_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
        (token, user_id, now() + 30 * 24 * 3600),
    )
    return token


def grant_plan(conn: sqlite3.Connection, user_id: str, plan: str) -> str:
    """幂等事务内发放套餐；单次额度与会员权益可同时保留。"""
    current = conn.execute("SELECT * FROM entitlements WHERE user_id=?", (user_id,)).fetchone()
    current_plan = current["plan"] if current else "none"
    credits = current["credits"] if current else 0
    expires_at = current["expires_at"] if current else None
    if plan == "single":
        credits += 1
        stored_plan = current_plan if current_plan in ("basic", "pro") and expires_at and expires_at > now() else "single"
        conn.execute(
            "INSERT INTO entitlements(user_id,plan,credits,expires_at) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET plan=?,credits=?,expires_at=?",
            (user_id, stored_plan, credits, expires_at, stored_plan, credits, expires_at),
        )
        return "Word/PDF 单次下载额度 × 1"

    base = expires_at if current_plan == plan and expires_at and expires_at > now() else now()
    new_expiry = base + 30 * 24 * 3600
    conn.execute(
        "INSERT INTO entitlements(user_id,plan,credits,expires_at,usage_date,usage_count) VALUES(?,?,?,?,NULL,0) "
        "ON CONFLICT(user_id) DO UPDATE SET plan=?,credits=?,expires_at=?,usage_date=NULL,usage_count=0",
        (user_id, plan, credits, new_expiry, plan, credits, new_expiry),
    )
    return "30 天会员 · 每周 35 次优化" if plan == "basic" else "30 天无限会员"


def fulfill_order(conn: sqlite3.Connection, order_no: str, transaction_id: str) -> dict:
    """到账后幂等发放权益；同一订单或交易号不会重复发放。"""
    order = conn.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone()
    if not order:
        raise ValueError("ORDER_NOT_FOUND")
    if order["status"] == "FULFILLED":
        return row_dict(order)
    if order["status"] not in ("PENDING", "PAID"):
        raise ValueError("INVALID_ORDER_STATUS")

    plan = order["plan"]
    user_id = order["user_id"]
    paid_at = now()
    conn.execute(
        "UPDATE orders SET status='PAID',provider_transaction_id=?,paid_at=? WHERE order_no=?",
        (transaction_id, paid_at, order_no),
    )
    grant_plan(conn, user_id, plan)
    conn.execute("UPDATE orders SET status='FULFILLED',fulfilled_at=? WHERE order_no=?", (now(), order_no))
    return row_dict(conn.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone())


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if DEMO_MODE:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def reply(self, data, status=HTTPStatus.OK):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def auth_user(self, conn: sqlite3.Connection):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        return conn.execute(
            "SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id "
            "WHERE sessions.token=? AND sessions.expires_at>?",
            (token, now()),
        ).fetchone()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/config":
            return self.reply({
                "demoMode": DEMO_MODE,
                "auth": {
                    "firebase": FIREBASE_AUTH_ENABLED,
                    "email": FIREBASE_AUTH_ENABLED,
                    "sms": False,
                    "wechat": False,
                    "apple": False,
                },
                "firebase": FIREBASE_WEB_CONFIG if FIREBASE_AUTH_ENABLED else None,
                "redemptionEnabled": True,
                "xianyuItemUrl": XIANYU_ITEM_URL,
                "xianyuItemUrls": XIANYU_ITEM_URLS,
                "directPaymentEnabled": DIRECT_PAYMENT_ENABLED,
                "message": "Firebase 邮箱认证已启用" if FIREBASE_AUTH_ENABLED else "Firebase 登录需要完整 Web 配置和令牌验证依赖"
            })
        if path in ("/api/auth/oauth/wechat/start", "/api/auth/oauth/apple/start"):
            return self.reply({"error": "OAUTH_PROVIDER_NOT_CONFIGURED"}, HTTPStatus.SERVICE_UNAVAILABLE)
        if path == "/api/me":
            with db() as conn:
                user = self.auth_user(conn)
                if not user:
                    return self.reply({"error": "UNAUTHORIZED"}, HTTPStatus.UNAUTHORIZED)
                user = refresh_daily_free_credits(conn, user["id"])
                entitlement = conn.execute("SELECT * FROM entitlements WHERE user_id=?", (user["id"],)).fetchone()
                orders = conn.execute("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20", (user["id"],)).fetchall()
                return self.reply({"user": row_dict(user), "entitlement": row_dict(entitlement), "orders": [row_dict(x) for x in orders]})
        if path.startswith("/api/payments/orders/"):
            order_no = path.rsplit("/", 1)[-1]
            with db() as conn:
                user = self.auth_user(conn)
                order = conn.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone()
                if not user or not order or order["user_id"] != user["id"]:
                    return self.reply({"error": "ORDER_NOT_FOUND"}, HTTPStatus.NOT_FOUND)
                return self.reply({"order": row_dict(order)})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self.json_body()
        except Exception:
            return self.reply({"error": "INVALID_JSON"}, HTTPStatus.BAD_REQUEST)

        if path == "/api/auth/firebase/session":
            if not FIREBASE_AUTH_ENABLED:
                return self.reply({"error": "FIREBASE_AUTH_NOT_CONFIGURED"}, HTTPStatus.SERVICE_UNAVAILABLE)
            id_token = str(body.get("id_token", "")).strip()
            if not id_token:
                return self.reply({"error": "FIREBASE_ID_TOKEN_REQUIRED"}, HTTPStatus.BAD_REQUEST)
            try:
                decoded = verify_firebase_id_token(id_token)
            except Exception as error:
                print(f"Firebase ID Token 验证失败：{error}")
                return self.reply({"error": "INVALID_FIREBASE_ID_TOKEN"}, HTTPStatus.UNAUTHORIZED)

            firebase_uid = str(decoded.get("uid") or decoded.get("sub") or "").strip()
            email = str(decoded.get("email") or "").strip().lower()
            raw_phone = str(decoded.get("phone_number") or "").strip()
            phone = raw_phone[3:] if raw_phone.startswith("+86") else raw_phone.lstrip("+")
            if not firebase_uid or (not phone and not email):
                return self.reply({"error": "FIREBASE_IDENTITY_REQUIRED"}, HTTPStatus.BAD_REQUEST)

            with db() as conn:
                user = conn.execute(
                    "SELECT * FROM users WHERE provider=? AND provider_subject=?",
                    ("firebase", firebase_uid),
                ).fetchone()
                if not user:
                    user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone() if email else None
                    if not user and phone:
                        user = conn.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
                    if user:
                        conn.execute(
                            "UPDATE users SET provider=?,provider_subject=?,email=COALESCE(email,?),phone=COALESCE(phone,?) WHERE id=?",
                            ("firebase", firebase_uid, email or None, phone or None, user["id"]),
                        )
                    else:
                        user_id = f"usr_{uuid.uuid4().hex[:16]}"
                        conn.execute(
                            "INSERT INTO users(id,phone,email,provider,provider_subject,free_credits,free_credit_date,created_at) VALUES(?,?,?,?,?,3,?,?)",
                            (user_id, phone or None, email or None, "firebase", firebase_uid, china_date_key(), now()),
                        )
                        user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                user = refresh_daily_free_credits(conn, user["id"])
                token = create_session(conn, user["id"])
                return self.reply({"token": token, "user": row_dict(user)})

        if path == "/api/auth/sms/send":
            phone = str(body.get("phone", ""))
            if len(phone) != 11 or not phone.isdigit():
                return self.reply({"error": "INVALID_PHONE"}, HTTPStatus.BAD_REQUEST)
            if not DEMO_MODE:
                return self.reply({"error": "SMS_PROVIDER_NOT_CONFIGURED"}, HTTPStatus.SERVICE_UNAVAILABLE)
            code = f"{secrets.randbelow(1_000_000):06d}"
            with db() as conn:
                conn.execute("INSERT OR REPLACE INTO verification_codes VALUES(?,?,?)", (phone, code, now() + 300))
            # 生产环境：在此调用阿里云/腾讯云短信，不得返回验证码。
            return self.reply({"sent": True, "demo_code": code if DEMO_MODE else None})

        if path == "/api/admin/redemption-codes":
            if not admin_secret_valid(self.headers):
                return self.reply({"error": "INVALID_ADMIN_SECRET"}, HTTPStatus.UNAUTHORIZED)
            order_no = str(body.get("xianyu_order_no", "")).strip()
            plan = str(body.get("plan", "")).strip()
            if len(order_no) < 6 or plan not in PLAN_TABLE:
                return self.reply({"error": "INVALID_ORDER_OR_PLAN"}, HTTPStatus.BAD_REQUEST)
            with db() as conn:
                existing = conn.execute("SELECT * FROM redemption_codes WHERE xianyu_order_no=?", (order_no,)).fetchone()
                if existing:
                    return self.reply({"redemption": row_dict(existing), "idempotent": True})
                code = make_redemption_code()
                conn.execute(
                    "INSERT INTO redemption_codes(code,xianyu_order_no,plan,status,created_at) VALUES(?,?,?,'UNUSED',?)",
                    (code, order_no, plan, now()),
                )
                created = conn.execute("SELECT * FROM redemption_codes WHERE code=?", (code,)).fetchone()
                return self.reply({"redemption": row_dict(created), "idempotent": False})

        if path == "/api/redemptions/redeem":
            with db() as conn:
                user = self.auth_user(conn)
                if not user:
                    return self.reply({"error": "UNAUTHORIZED"}, HTTPStatus.UNAUTHORIZED)
                code = str(body.get("code", "")).strip().upper()
                conn.execute("BEGIN IMMEDIATE")
                redemption = conn.execute("SELECT * FROM redemption_codes WHERE code=?", (code,)).fetchone()
                if not redemption:
                    conn.rollback()
                    return self.reply({"error": "INVALID_REDEMPTION_CODE"}, HTTPStatus.NOT_FOUND)
                if redemption["status"] == "REDEEMED":
                    if redemption["redeemed_by"] == user["id"]:
                        conn.commit()
                        return self.reply({"ok": True, "already_redeemed": True, "plan": redemption["plan"]})
                    conn.rollback()
                    return self.reply({"error": "REDEMPTION_CODE_USED"}, HTTPStatus.CONFLICT)
                grant_text = grant_plan(conn, user["id"], redemption["plan"])
                conn.execute(
                    "UPDATE redemption_codes SET status='REDEEMED',redeemed_by=?,redeemed_at=? WHERE code=? AND status='UNUSED'",
                    (user["id"], now(), code),
                )
                conn.commit()
                return self.reply({"ok": True, "plan": redemption["plan"], "grant_text": grant_text})

        if path == "/api/auth/logout":
            token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            with db() as conn:
                conn.execute("DELETE FROM sessions WHERE token=?", (token,))
            return self.reply({"ok": True})

        if path == "/api/auth/sms/verify":
            phone, code = str(body.get("phone", "")), str(body.get("code", ""))
            with db() as conn:
                valid = conn.execute("SELECT 1 FROM verification_codes WHERE phone=? AND code=? AND expires_at>?", (phone, code, now())).fetchone()
                if not valid:
                    return self.reply({"error": "INVALID_CODE"}, HTTPStatus.BAD_REQUEST)
                user = conn.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
                if not user:
                    user_id = f"usr_{uuid.uuid4().hex[:16]}"
                    conn.execute(
                        "INSERT INTO users(id,phone,provider,provider_subject,free_credits,free_credit_date,created_at) VALUES(?,?,?,NULL,3,?,?)",
                        (user_id, phone, "phone", china_date_key(), now()),
                    )
                user = refresh_daily_free_credits(conn, user["id"] if user else user_id)
                token = create_session(conn, user["id"])
                conn.execute("DELETE FROM verification_codes WHERE phone=?", (phone,))
                return self.reply({"token": token, "user": row_dict(user)})

        if path == "/api/auth/oauth/demo" and DEMO_MODE:
            provider, subject = body.get("provider"), str(body.get("subject", ""))
            if provider not in ("wechat", "apple") or not subject:
                return self.reply({"error": "INVALID_OAUTH_IDENTITY"}, HTTPStatus.BAD_REQUEST)
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE provider=? AND provider_subject=?", (provider, subject)).fetchone()
                if not user:
                    user_id = f"usr_{uuid.uuid4().hex[:16]}"
                    conn.execute(
                        "INSERT INTO users(id,phone,provider,provider_subject,free_credits,free_credit_date,created_at) VALUES(?,NULL,?,?,3,?,?)",
                        (user_id, provider, subject, china_date_key(), now()),
                    )
                user = refresh_daily_free_credits(conn, user["id"] if user else user_id)
                token = create_session(conn, user["id"])
                return self.reply({"token": token, "user": row_dict(user), "demo": True})

        if path == "/api/payments/orders":
            with db() as conn:
                user = self.auth_user(conn)
                if not user:
                    return self.reply({"error": "UNAUTHORIZED"}, HTTPStatus.UNAUTHORIZED)
                plan, method = body.get("plan"), body.get("method")
                if plan not in PLAN_TABLE or method not in ("wechat", "alipay"):
                    return self.reply({"error": "INVALID_PLAN_OR_METHOD"}, HTTPStatus.BAD_REQUEST)
                order_no = f"XQ{int(time.time())}{secrets.randbelow(100000):05d}"
                amount = PLAN_TABLE[plan]["amount"]  # 金额必须由服务端决定，不能相信前端。
                conn.execute(
                    "INSERT INTO orders(order_no,user_id,plan,method,amount,status,created_at) VALUES(?,?,?,?,?,'PENDING',?)",
                    (order_no, user["id"], plan, method, amount, now()),
                )
                # 生产环境：调用微信 Native 下单或支付宝当面付，返回真实 code_url/qr_code。
                if not DEMO_MODE:
                    conn.execute("UPDATE orders SET status='CLOSED' WHERE order_no=?", (order_no,))
                    return self.reply({"error": "PAYMENT_PROVIDER_NOT_CONFIGURED"}, HTTPStatus.SERVICE_UNAVAILABLE)
                return self.reply({"order_no": order_no, "amount": amount, "status": "PENDING", "qr_code": None, "qr_image_url": None, "demo": DEMO_MODE})

        if path == "/api/quota/consume":
            with db() as conn:
                user = self.auth_user(conn)
                if not user:
                    return self.reply({"error": "UNAUTHORIZED"}, HTTPStatus.UNAUTHORIZED)
                conn.execute("BEGIN IMMEDIATE")
                fresh_user = refresh_daily_free_credits(conn, user["id"])
                entitlement = conn.execute("SELECT * FROM entitlements WHERE user_id=?", (user["id"],)).fetchone()
                active_member = (
                    entitlement
                    and entitlement["plan"] in ("basic", "pro")
                    and entitlement["expires_at"]
                    and entitlement["expires_at"] > now()
                )
                if active_member:
                    conn.commit()
                    return self.reply({"allowed": True, "source": entitlement["plan"]})
                if fresh_user["free_credits"] > 0:
                    remaining = fresh_user["free_credits"] - 1
                    conn.execute("UPDATE users SET free_credits=? WHERE id=?", (remaining, user["id"]))
                    conn.commit()
                    return self.reply({"allowed": True, "source": "free", "remaining": remaining})
                if not entitlement:
                    conn.rollback()
                    return self.reply({"allowed": False, "reason": "PAYMENT_REQUIRED"}, HTTPStatus.PAYMENT_REQUIRED)
                if entitlement["credits"] > 0:
                    remaining = entitlement["credits"] - 1
                    conn.execute("UPDATE entitlements SET credits=? WHERE user_id=?", (remaining, user["id"]))
                    conn.commit()
                    return self.reply({"allowed": True, "source": "single", "remaining": remaining})
                conn.rollback()
                return self.reply({"allowed": False, "reason": "PAYMENT_REQUIRED"}, HTTPStatus.PAYMENT_REQUIRED)

        if path == "/api/optimization/quota/consume":
            with db() as conn:
                user = self.auth_user(conn)
                if not user:
                    return self.reply({"error": "UNAUTHORIZED"}, HTTPStatus.UNAUTHORIZED)
                conn.execute("BEGIN IMMEDIATE")
                entitlement = conn.execute("SELECT * FROM entitlements WHERE user_id=?", (user["id"],)).fetchone()
                active = entitlement and entitlement["expires_at"] and entitlement["expires_at"] > now()
                if not active or entitlement["plan"] not in ("basic", "pro"):
                    conn.rollback()
                    return self.reply({"allowed": False, "reason": "MEMBERSHIP_REQUIRED"}, HTTPStatus.PAYMENT_REQUIRED)
                if entitlement["plan"] == "pro":
                    conn.commit()
                    return self.reply({"allowed": True, "source": "pro", "remaining": None})
                week = china_week_key()
                used = entitlement["usage_count"] if entitlement["usage_date"] == week else 0
                if used >= 35:
                    conn.rollback()
                    return self.reply({"allowed": False, "reason": "WEEKLY_LIMIT_REACHED", "remaining": 0}, HTTPStatus.TOO_MANY_REQUESTS)
                conn.execute("UPDATE entitlements SET usage_date=?,usage_count=? WHERE user_id=?", (week, used + 1, user["id"]))
                conn.commit()
                return self.reply({"allowed": True, "source": "basic", "remaining": 34 - used})

        if path == "/api/payments/demo-confirm" and DEMO_MODE:
            with db() as conn:
                user = self.auth_user(conn)
                order = conn.execute("SELECT * FROM orders WHERE order_no=?", (body.get("order_no"),)).fetchone()
                if not user or not order or order["user_id"] != user["id"]:
                    return self.reply({"error": "ORDER_NOT_FOUND"}, HTTPStatus.NOT_FOUND)
                result = fulfill_order(conn, order["order_no"], f"DEMO_{uuid.uuid4().hex}")
                return self.reply({"order": result})

        if path.startswith("/api/payments/webhook/"):
            # 正式微信/支付宝必须替换为官方证书验签；此共享密钥接口仅供联调。
            if not WEBHOOK_SECRET or self.headers.get("X-Webhook-Secret") != WEBHOOK_SECRET:
                return self.reply({"error": "INVALID_SIGNATURE"}, HTTPStatus.UNAUTHORIZED)
            order_no = body.get("order_no")
            with db() as conn:
                order = conn.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone()
                if not order or float(body.get("amount", -1)) != float(order["amount"]):
                    return self.reply({"error": "ORDER_OR_AMOUNT_MISMATCH"}, HTTPStatus.BAD_REQUEST)
                result = fulfill_order(conn, order_no, str(body.get("transaction_id")))
                return self.reply({"ok": True, "order": result})

        return self.reply({"error": "NOT_FOUND"}, HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    init_db()
    port = int(os.getenv("PORT", "4173"))
    print(
        f"向晴简历：http://127.0.0.1:{port}  "
        f"DEMO_MODE={DEMO_MODE}  FIREBASE_AUTH={FIREBASE_AUTH_ENABLED}"
    )
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
