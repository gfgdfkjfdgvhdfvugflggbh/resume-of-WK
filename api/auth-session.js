import { firestore } from '../api-lib/firebase.js';
import { bodyOf, json, method } from '../api-lib/http.js';
import { ensureUser, publicUser } from '../api-lib/models.js';
import { adminAuth } from '../api-lib/firebase.js';

export default async function handler(request, response) {
  if (!method(request, response, ['POST'])) return;
  try {
    const body = bodyOf(request);
    const idToken = String(body.id_token || '').trim();
    if (!idToken) return json(response, 400, { error: 'FIREBASE_ID_TOKEN_REQUIRED' });
    const decoded = await adminAuth().verifyIdToken(idToken);
    const user = await ensureUser(decoded);
    await firestore().collection('sessions').doc(decoded.uid).set({ uid: decoded.uid, lastLoginAt: Date.now() }, { merge: true });
    return json(response, 200, { token: idToken, user: publicUser(user) });
  } catch (error) {
    console.error('Firebase session failed', error?.code || error?.message);
    return json(response, 401, { error: 'INVALID_FIREBASE_ID_TOKEN' });
  }
}
