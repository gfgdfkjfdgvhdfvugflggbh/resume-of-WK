import crypto from 'node:crypto';
import { firestore } from '../api-lib/firebase.js';
import { bodyOf, json, method, requireUser } from '../api-lib/http.js';
import { publicOrder } from '../api-lib/models.js';

function claimDocumentId(orderNo) {
  return crypto.createHash('sha256').update(orderNo).digest('hex');
}

export default async function handler(request, response) {
  if (!method(request, response, ['POST'])) return;
  const decoded = await requireUser(request, response);
  if (!decoded) return;

  const body = bodyOf(request);
  const websiteOrderNo = String(body.website_order_no || '').trim();
  const xianyuOrderNo = String(body.xianyu_order_no || '').trim();
  if (websiteOrderNo.length < 10 || xianyuOrderNo.length < 6 || xianyuOrderNo.length > 64 || /\s/.test(xianyuOrderNo)) {
    return json(response, 400, { error: 'INVALID_CLAIM_DATA' });
  }

  const db = firestore();
  try {
    const result = await db.runTransaction(async transaction => {
      const orderRef = db.collection('orders').doc(websiteOrderNo);
      const claimRef = db.collection('xianyuClaims').doc(claimDocumentId(xianyuOrderNo));
      const [orderSnapshot, claimSnapshot] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(claimRef)
      ]);
      if (!orderSnapshot.exists || orderSnapshot.data().uid !== decoded.uid) throw new Error('ORDER_NOT_FOUND');
      const order = orderSnapshot.data();
      if (order.status === 'FULFILLED') return { order, idempotent: true };
      if (!['PENDING', 'VERIFYING'].includes(order.status)) throw new Error('INVALID_ORDER_STATUS');
      if (order.xianyuClaimNo && order.xianyuClaimNo !== xianyuOrderNo) throw new Error('ORDER_ALREADY_CLAIMED');
      if (claimSnapshot.exists && claimSnapshot.data().websiteOrderNo !== websiteOrderNo) throw new Error('XIANYU_ORDER_ALREADY_CLAIMED');

      const now = Date.now();
      const claimedOrder = {
        ...order,
        status: 'VERIFYING',
        xianyuClaimNo: xianyuOrderNo,
        claimSubmittedAt: order.claimSubmittedAt || now,
        updatedAt: now
      };
      transaction.set(orderRef, claimedOrder);
      transaction.set(claimRef, {
        xianyuOrderNo,
        websiteOrderNo,
        uid: decoded.uid,
        createdAt: claimSnapshot.exists ? claimSnapshot.data().createdAt : now,
        updatedAt: now
      });
      return { order: claimedOrder, idempotent: Boolean(claimSnapshot.exists) };
    });
    return json(response, 200, { ok: true, idempotent: result.idempotent, order: publicOrder(result.order) });
  } catch (error) {
    const code = error?.message || 'CLAIM_FAILED';
    const status = code === 'ORDER_NOT_FOUND' ? 404 : ['ORDER_ALREADY_CLAIMED', 'XIANYU_ORDER_ALREADY_CLAIMED'].includes(code) ? 409 : 400;
    return json(response, status, { error: code });
  }
}
