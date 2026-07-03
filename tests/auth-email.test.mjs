import assert from 'node:assert/strict';
import handler from '../api/auth-email.js';

function request(body) {
  return { method: 'POST', body, headers: {} };
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.payload = JSON.parse(value); }
  };
}

const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  if (url.includes('securetoken')) {
    return { ok: true, json: async () => ({ user_id: 'uid-1', id_token: 'id-2', refresh_token: 'refresh-2', expires_in: '3600' }) };
  }
  if (url.includes('sendOobCode')) return { ok: true, json: async () => ({ email: 'user@example.com' }) };
  return { ok: true, json: async () => ({ localId: 'uid-1', email: 'user@example.com', idToken: 'id-1', refreshToken: 'refresh-1', expiresIn: '3600' }) };
};

for (const action of ['signup', 'signin']) {
  const result = response();
  await handler(request({ action, email: 'user@example.com', password: 'secret123' }), result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.user.uid, 'uid-1');
  assert.equal(result.payload.user.refreshToken, 'refresh-1');
  assert.match(calls.at(-1).url, action === 'signup' ? /accounts:signUp/ : /accounts:signInWithPassword/);
}

const refreshed = response();
await handler(request({ action: 'refresh', refresh_token: 'refresh-token-value-long-enough' }), refreshed);
assert.equal(refreshed.statusCode, 200);
assert.equal(refreshed.payload.user.idToken, 'id-2');
assert.match(calls.at(-1).options.body, /grant_type=refresh_token/);

const reset = response();
await handler(request({ action: 'reset', email: 'user@example.com' }), reset);
assert.equal(reset.statusCode, 200);
assert.match(calls.at(-1).url, /accounts:sendOobCode/);

const invalid = response();
await handler(request({ action: 'signin', email: 'bad', password: 'secret123' }), invalid);
assert.equal(invalid.statusCode, 400);
assert.equal(invalid.payload.error, 'INVALID_EMAIL');

console.log('auth email proxy tests passed');
