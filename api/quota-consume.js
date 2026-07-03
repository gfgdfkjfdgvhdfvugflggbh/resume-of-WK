import { firestore } from '../api-lib/firebase.js';
import { json, method, requireUser } from '../api-lib/http.js';
import { chinaDateKey, chinaWeekKey } from '../api-lib/plans.js';

export default async function handler(request, response) {
  if (!method(request, response, ['POST'])) return;
  const decoded = await requireUser(request, response);
  if (!decoded) return;
  const db = firestore();
  try {
    const result = await db.runTransaction(async transaction => {
      const userRef = db.collection('users').doc(decoded.uid);
      const entitlementRef = db.collection('entitlements').doc(decoded.uid);
      const [userSnapshot, entitlementSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(entitlementRef)
      ]);
      if (!userSnapshot.exists) throw new Error('USER_NOT_FOUND');
      const today = chinaDateKey();
      const user = userSnapshot.data();
      const entitlement = entitlementSnapshot.exists ? entitlementSnapshot.data() : null;
      const activeMember = entitlement && ['basic', 'pro'].includes(entitlement.plan) && Number(entitlement.expiresAt || 0) > Date.now();
      if (activeMember && entitlement.plan === 'pro') return { allowed: true, source: 'pro', remaining: null };
      if (activeMember && entitlement.plan === 'basic') {
        const week = chinaWeekKey();
        const used = entitlement.usageDate === week ? Number(entitlement.usageCount || 0) : 0;
        if (used >= 35) throw new Error('WEEKLY_LIMIT_REACHED');
        transaction.set(entitlementRef, { usageDate: week, usageCount: used + 1, updatedAt: Date.now() }, { merge: true });
        return { allowed: true, source: 'basic', remaining: 34 - used };
      }
      const freeCredits = user.freeCreditDate === today ? Number(user.freeCredits || 0) : 3;
      if (freeCredits > 0) {
        transaction.set(userRef, { freeCredits: freeCredits - 1, freeCreditDate: today, updatedAt: Date.now() }, { merge: true });
        return { allowed: true, source: 'free', remaining: freeCredits - 1 };
      }
      if (entitlement && Number(entitlement.credits || 0) > 0) {
        transaction.set(entitlementRef, { credits: Number(entitlement.credits) - 1, updatedAt: Date.now() }, { merge: true });
        return { allowed: true, source: 'single', remaining: Number(entitlement.credits) - 1 };
      }
      throw new Error('PAYMENT_REQUIRED');
    });
    return json(response, 200, result);
  } catch (error) {
    if (error?.message === 'PAYMENT_REQUIRED') return json(response, 402, { allowed: false, reason: 'PAYMENT_REQUIRED' });
    if (error?.message === 'WEEKLY_LIMIT_REACHED') return json(response, 402, { allowed: false, reason: 'WEEKLY_LIMIT_REACHED' });
    return json(response, 400, { error: error?.message || 'QUOTA_CHECK_FAILED' });
  }
}
