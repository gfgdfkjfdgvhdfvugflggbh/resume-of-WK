import crypto from 'node:crypto';
import { firestore } from '../api-lib/firebase.js';
import { bodyOf, json, method, requireUser } from '../api-lib/http.js';
import { ensureUser, publicOrder } from '../api-lib/models.js';
import { PLANS } from '../api-lib/plans.js';

function makeOrderNo() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `XQ${stamp}${crypto.randomInt(10000, 99999)}`;
}

export default async function handler(request, response) {
  if (!method(request, response, ['GET', 'POST'])) return;
  const decoded = await requireUser(request, response);
  if (!decoded) return;
  const db = firestore();
  if (request.method === 'POST') {
    const body = bodyOf(request);
    const plan = PLANS[String(body.plan || '')];
    if (!plan) return json(response, 400, { error: 'INVALID_PLAN' });
    const user = await ensureUser(decoded);
    const orderNo = makeOrderNo();
    const order = {
      orderNo,
      uid: decoded.uid,
      email: user.email || decoded.email || '',
      plan: plan.id,
      amount: plan.amount,
      amountCents: plan.amountCents,
      status: 'PENDING',
      method: 'xianyu',
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    };
    await db.collection('orders').doc(orderNo).create(order);
    return json(response, 201, { order: publicOrder(order) });
  }

  const orderNo = String(request.query.order_no || '').trim();
  if (!orderNo) return json(response, 400, { error: 'ORDER_NO_REQUIRED' });
  const snapshot = await db.collection('orders').doc(orderNo).get();
  if (!snapshot.exists || snapshot.data().uid !== decoded.uid) return json(response, 404, { error: 'ORDER_NOT_FOUND' });
  return json(response, 200, { order: publicOrder(snapshot.data()) });
}
