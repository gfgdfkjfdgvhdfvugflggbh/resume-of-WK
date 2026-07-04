import assert from 'node:assert/strict';
import { publicOrder } from '../api-lib/models.js';
import { PLANS } from '../api-lib/plans.js';

const claimed = publicOrder({
  orderNo: 'XQ202607030001',
  uid: 'user-1',
  email: 'user@example.com',
  plan: 'basic',
  amount: 19.8,
  status: 'VERIFYING',
  xianyuClaimNo: 'XY123456789',
  createdAt: Date.now()
});

assert.equal(claimed.status, 'VERIFYING');
assert.equal(claimed.xianyu_claim_no, 'XY123456789');
assert.equal(PLANS[claimed.plan].amountCents, 1980);
assert.equal(PLANS.single.amountCents, 298);
assert.equal(PLANS.pro.amountCents, 2980);

console.log('order claim mapping tests passed');
