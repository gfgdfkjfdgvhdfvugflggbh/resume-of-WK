import { firestore } from './firebase.js';
import { chinaDateKey } from './plans.js';

export async function ensureUser(decoded) {
  const db = firestore();
  const ref = db.collection('users').doc(decoded.uid);
  const today = chinaDateKey();
  let resolvedUser = null;
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      resolvedUser = {
        uid: decoded.uid,
        email: String(decoded.email || '').toLowerCase(),
        provider: 'firebase',
        freeCredits: 3,
        freeCreditDate: today,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      transaction.set(ref, resolvedUser);
      return;
    }
    const data = snapshot.data();
    const updates = {
      email: String(decoded.email || data.email || '').toLowerCase(),
      freeCredits: data.freeCreditDate === today ? Number(data.freeCredits || 0) : 3,
      freeCreditDate: today,
      updatedAt: Date.now()
    };
    resolvedUser = { ...data, ...updates };
    transaction.set(ref, updates, { merge: true });
  });
  return resolvedUser;
}

export function publicUser(data) {
  return {
    id: data.uid,
    email: data.email || '',
    phone: '',
    provider: 'firebase',
    provider_subject: data.uid,
    free_credits: Number(data.freeCredits || 0),
    free_credit_date: data.freeCreditDate || '',
    created_at: Math.floor(Number(data.createdAt || Date.now()) / 1000)
  };
}

export function publicEntitlement(data, uid) {
  if (!data) return null;
  return {
    user_id: uid,
    plan: data.plan || 'none',
    credits: Number(data.credits || 0),
    expires_at: data.expiresAt ? Math.floor(Number(data.expiresAt) / 1000) : null,
    usage_date: data.usageDate || '',
    usage_count: Number(data.usageCount || 0)
  };
}

export function publicOrder(data) {
  return {
    order_no: data.orderNo,
    user_id: data.uid,
    email: data.email || '',
    plan: data.plan,
    method: 'xianyu',
    amount: data.amount,
    status: data.status,
    xianyu_order_no: data.xianyuOrderNo || null,
    created_at: Math.floor(Number(data.createdAt || Date.now()) / 1000),
    paid_at: data.paidAt ? Math.floor(Number(data.paidAt) / 1000) : null,
    fulfilled_at: data.fulfilledAt ? Math.floor(Number(data.fulfilledAt) / 1000) : null,
    grant_text: data.grantText || ''
  };
}
