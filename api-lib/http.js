import crypto from 'node:crypto';
import { adminAuth } from './firebase.js';

export function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

export function method(request, response, allowed) {
  if (allowed.includes(request.method)) return true;
  response.setHeader('Allow', allowed.join(', '));
  json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  return false;
}

export async function requireUser(request, response) {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    json(response, 401, { error: 'UNAUTHORIZED' });
    return null;
  }
  try {
    return await adminAuth().verifyIdToken(token, true);
  } catch (error) {
    console.error('Firebase token verification failed', error?.code || error?.message);
    json(response, 401, { error: 'INVALID_FIREBASE_TOKEN' });
    return null;
  }
}

export function requireAdmin(request, response) {
  const expected = process.env.ADMIN_SECRET || '';
  const provided = String(request.headers['x-admin-secret'] || '');
  const valid = expected && provided && expected.length === provided.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  if (valid) return true;
  json(response, 401, { error: 'INVALID_ADMIN_SECRET' });
  return false;
}

export function bodyOf(request) {
  return typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
}
