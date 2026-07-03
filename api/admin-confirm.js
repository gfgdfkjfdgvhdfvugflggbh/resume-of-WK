import crypto from 'node:crypto';
import { firestore } from '../api-lib/firebase.js';
import { bodyOf, json, method, requireAdmin } from '../api-lib/http.js';
import { publicOrder } from '../api-lib/models.js';
import { amountToCents, PLANS } from '../api-lib/plans.js';

function xianyuDocumentId(orderNo) {
  return crypto.createHash('sha256').update(orderNo).digest('hex');
}

export default async function handler(request, response) {
  if (!method(request, response, ['POST'])) return;
  if (!requireAdmin(request, response)) return;
  const body = bodyOf(request);
  const websiteOrderNo = String(body.website_order_no || '').trim();
  const xianyuOrderNo = String(body.xianyu_order_no || '').trim();
  const paidCents = amountToCents(body.paid_amount);
  if (websiteOrderNo.length < 10 || xianyuOrderNo.length < 6 || paidCents === null) {
    return json(response, 400, { error: 'INVALID_CONFIRMATION_DATA' });
  }

  const db = firestore();
  try {
    const result = await db.runTransaction(async transaction => {
      const orderRef = db.collection('orders').doc(websiteOrderNo);
      const xianyuRef = db.collection('xianyuOrders').doc(xianyuDocumentId(xianyuOrderNo));
      const [orderSnapshot, xianyuSnapshot] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(xianyuRef)
      ]);
      if (!orderSnapshot.exists) throw new Error('ORDER_NOT_FOUND');
      const order = orderSnapshot.data();
      const plan = PLANS[order.plan];
      if (!plan || paidCents !== plan.amountCents) throw new Error('AMOUNT_MISMATCH');
      if (order.status === 'FULFILLED') {
        if (order.xianyuOrderNo !== xianyuOrderNo) throw new Error('ORDER_ALREADY_CONFIRMED');
        return { order, idempotent: true };
      }
      if (xianyuSnapshot.exists && xianyuSnapshot.data().websiteOrderNo !== websiteOrderNo) throw new Error('XIANYU_ORDER_ALREADY_USED');
      if (order.status !== 'PENDING') throw new Error('INVALID_ORDER_STATUS');

      const entitlementRef = db.collection('entitlements').doc(order.uid);
      const entitlementSnapshot = await transaction.get(entitlementRef);
      const current = entitlementSnapshot.exists ? entitlementSnapshot.data() : {};
      const now = Date.now();
      const next = {
        uid: order.uid,
        plan: current.plan || 'none',
        credits: Number(current.credits || 0),
        expiresAt: Number(current.expiresAt || 0),
        usageDate: current.usageDate || '',
        usageCount: Number(current.usageCount || 0),
        updatedAt: now
      };
      if (plan.id === 'single') {
        next.credits += 1;
        if (!['basic', 'pro'].includes(next.plan) || next.expiresAt <= now) next.plan = 'single';
      } else {
        const base = next.plan === plan.id && next.expiresAt > now ? next.expiresAt : now;
        next.plan = plan.id;
        next.expiresAt = base + 30 * 24 * 60 * 60 * 1000;
        next.usageDate = '';
        next.usageCount = 0;
      }
      const fulfilledOrder = {
        ...order,
        status: 'FULFILLED',
        paidAt: now,
        fulfilledAt: now,
        xianyuOrderNo,
        paidAmountCents: paidCents,
        grantText: plan.grantText,
        confirmedBy: 'admin'
      };
      transaction.set(entitlementRef, next, { merge: true });
      transaction.set(xianyuRef, { xianyuOrderNo, websiteOrderNo, uid: order.uid, amountCents: paidCents, createdAt: now });
      transaction.set(orderRef, fulfilledOrder);
      return { order: fulfilledOrder, idempotent: false };
    });
    return json(response, 200, { ok: true, idempotent: result.idempotent, order: publicOrder(result.order) });
  } catch (error) {
    const code = error?.message || 'CONFIRMATION_FAILED';
    const status = code === 'ORDER_NOT_FOUND' ? 404 : ['XIANYU_ORDER_ALREADY_USED', 'ORDER_ALREADY_CONFIRMED'].includes(code) ? 409 : 400;
    return json(response, status, { error: code });
  }
}
