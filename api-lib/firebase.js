import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';
  if (!raw && !encoded) return null;
  const json = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : raw;
  return JSON.parse(json);
}

export function firebaseAdminConfigured() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64);
}

function app() {
  if (getApps().length) return getApps()[0];
  const account = readServiceAccount();
  if (!account) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  return initializeApp({ credential: cert(account), projectId: account.project_id });
}

export function adminAuth() {
  return getAuth(app());
}

export function firestore() {
  return getFirestore(app());
}
