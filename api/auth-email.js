import { bodyOf, json, method } from '../api-lib/http.js';

const DEFAULT_FIREBASE_API_KEY = 'AIzaSyC0FOEpZIjOJpcRrTX1Jm5cre6nOFewKLc';
const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_BASE = 'https://securetoken.googleapis.com/v1';

function firebaseApiKey() {
  return process.env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

async function firebaseRequest(url, { body, form = false } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: form
      ? { 'Content-Type': 'application/x-www-form-urlencoded' }
      : { 'Content-Type': 'application/json', 'X-Firebase-Locale': 'zh-CN' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(data?.error?.message || 'FIREBASE_AUTH_FAILED').split(' : ')[0];
    const error = new Error(code);
    error.status = response.status;
    throw error;
  }
  return data;
}

function publicAuthResult(data) {
  return {
    uid: data.localId || data.user_id || '',
    email: data.email || '',
    displayName: data.displayName || '',
    idToken: data.idToken || data.id_token || '',
    refreshToken: data.refreshToken || data.refresh_token || '',
    expiresIn: Number(data.expiresIn || data.expires_in || 3600)
  };
}

export default async function handler(request, response) {
  if (!method(request, response, ['POST'])) return;
  try {
    const body = bodyOf(request);
    const action = String(body.action || '');
    const key = firebaseApiKey();

    if (action === 'refresh') {
      const refreshToken = String(body.refresh_token || '').trim();
      if (refreshToken.length < 20) return json(response, 400, { error: 'MISSING_REFRESH_TOKEN' });
      const data = await firebaseRequest(`${TOKEN_BASE}/token?key=${encodeURIComponent(key)}`, {
        form: true,
        body: { grant_type: 'refresh_token', refresh_token: refreshToken }
      });
      return json(response, 200, { user: publicAuthResult(data) });
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return json(response, 400, { error: 'INVALID_EMAIL' });

    if (action === 'reset') {
      await firebaseRequest(`${IDENTITY_BASE}/accounts:sendOobCode?key=${encodeURIComponent(key)}`, {
        body: { requestType: 'PASSWORD_RESET', email }
      });
      return json(response, 200, { ok: true });
    }

    const password = String(body.password || '');
    if (password.length < 6 || password.length > 128) return json(response, 400, { error: 'WEAK_PASSWORD' });
    const endpoint = action === 'signup' ? 'signUp' : action === 'signin' ? 'signInWithPassword' : '';
    if (!endpoint) return json(response, 400, { error: 'INVALID_AUTH_ACTION' });
    const data = await firebaseRequest(`${IDENTITY_BASE}/accounts:${endpoint}?key=${encodeURIComponent(key)}`, {
      body: { email, password, returnSecureToken: true }
    });
    return json(response, 200, { user: publicAuthResult(data) });
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'AUTH_UPSTREAM_TIMEOUT' : String(error?.message || 'FIREBASE_AUTH_FAILED');
    const status = code === 'AUTH_UPSTREAM_TIMEOUT' ? 504 : [400, 401, 403].includes(error?.status) ? 401 : 502;
    return json(response, status, { error: code });
  }
}
