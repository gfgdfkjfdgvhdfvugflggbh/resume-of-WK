import { firebaseAdminConfigured } from '../api-lib/firebase.js';
import { json, method } from '../api-lib/http.js';

const DEFAULT_XIANYU_URLS = Object.freeze({
  single: 'https://m.tb.cn/h.RvJF1Sb?tk=07vFgPDqfsx',
  basic: 'https://m.tb.cn/h.RvJw8Mt?tk=w9GtgPDrd8x',
  pro: 'https://m.tb.cn/h.RvJDEOQ?tk=bALjgPDs6dw'
});

export default async function handler(request, response) {
  if (!method(request, response, ['GET'])) return;
  if (!firebaseAdminConfigured()) return json(response, 503, { error: 'FIREBASE_ADMIN_NOT_CONFIGURED' });
  return json(response, 200, {
    demoMode: false,
    auth: { firebase: true, email: true, proxy: true, sms: false, wechat: false, apple: false },
    firebase: null,
    orderMode: 'xianyu_manual_confirmation',
    xianyuItemUrl: process.env.XIANYU_ITEM_URL || DEFAULT_XIANYU_URLS.single,
    xianyuItemUrls: {
      single: process.env.XIANYU_SINGLE_URL || process.env.XIANYU_ITEM_URL || DEFAULT_XIANYU_URLS.single,
      basic: process.env.XIANYU_BASIC_URL || process.env.XIANYU_ITEM_URL || DEFAULT_XIANYU_URLS.basic,
      pro: process.env.XIANYU_PRO_URL || process.env.XIANYU_ITEM_URL || DEFAULT_XIANYU_URLS.pro
    },
    directPaymentEnabled: false,
    redemptionEnabled: false
  });
}
