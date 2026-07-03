import { firestore } from '../api-lib/firebase.js';
import { json, method, requireUser } from '../api-lib/http.js';
import { ensureUser, publicEntitlement, publicOrder, publicUser } from '../api-lib/models.js';

export default async function handler(request, response) {
  if (!method(request, response, ['GET'])) return;
  const decoded = await requireUser(request, response);
  if (!decoded) return;
  const db = firestore();
  const user = await ensureUser(decoded);
  const [entitlementSnapshot, ordersSnapshot] = await Promise.all([
    db.collection('entitlements').doc(decoded.uid).get(),
    db.collection('orders').where('uid', '==', decoded.uid).limit(50).get()
  ]);
  return json(response, 200, {
    user: publicUser(user),
    entitlement: publicEntitlement(entitlementSnapshot.exists ? entitlementSnapshot.data() : null, decoded.uid),
    orders: ordersSnapshot.docs
      .map(document => document.data())
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 20)
      .map(publicOrder)
  });
}
