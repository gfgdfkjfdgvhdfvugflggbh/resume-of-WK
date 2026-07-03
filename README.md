# resume-of-WK

向晴简历 Web 应用，包含简历解析、优化预览、Firebase 邮箱认证、每日免费额度，以及闲鱼订单核款与账号权益直充闭环。

## 本地启动

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
.venv/bin/python server.py
```

浏览器打开 `http://127.0.0.1:4173`。

## 配置 Firebase Authentication

1. 在 Firebase 控制台创建项目并注册 Web 应用。
2. 在 **Authentication → 登录方法** 中启用“电子邮件/密码”。
3. 将 Web 应用配置填写到 `.env` 的 `FIREBASE_*` 字段。
4. 在 Authentication 的授权网域中加入正式域名；本地开发保留 `localhost`。
5. 重启 `.venv/bin/python server.py`，访问 `/api/config`，确认 `auth.firebase` 为 `true`。

后端默认使用 Google 发布的 Firebase 公钥校验 ID Token 的签名、项目 ID、签发方和有效期。若还需要检测账号封禁/令牌撤销或使用 Admin 用户管理功能，再在 **项目设置 → 服务账号** 中生成私钥，把 JSON 保存在仓库之外，并将其绝对路径填写到 `GOOGLE_APPLICATION_CREDENTIALS`。

Firebase Web 配置（包括 API Key）会发送给浏览器，这是 Firebase 的正常设计；真正的服务账号私钥只保存在服务器上，绝不能提交到 Git。

正式域名 `hh.nihaojianli.top` 需要加入 Firebase Authentication 的授权网域。注册成功的邮箱用户可在 Firebase 控制台的 Authentication → Users 中查看。

> 仓库已经包含 Firestore + Vercel Functions 的生产数据层；上线前仍需按下方配置文档启用 Firestore，并在 Vercel 填写服务账号、后台密钥和闲鱼商品链接。浏览器本地数据不作为正式付费权益依据。

## 闲鱼订单闭环

仓库已包含 Vercel Functions + Firestore 的订单闭环：网站创建订单、卖家人工核对闲鱼到账、服务端事务发放权益、用户端轮询到账状态。部署所需环境变量与操作见 [闲鱼闭环上线配置.md](./闲鱼闭环上线配置.md)。
