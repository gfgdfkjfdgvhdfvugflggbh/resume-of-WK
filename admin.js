const secretInput = document.querySelector('#adminSecret');
const websiteOrderInput = document.querySelector('#websiteOrder');
const orderInput = document.querySelector('#xianyuOrder');
const amountInput = document.querySelector('#paidAmount');
const resultBox = document.querySelector('#adminResult');
const confirmButton = document.querySelector('#confirmOrder');
const loadPendingButton = document.querySelector('#loadPendingOrders');
const pendingQueue = document.querySelector('#pendingOrderQueue');
let pendingOrders = [];

loadPendingButton.addEventListener('click', loadPendingOrders);
pendingQueue.addEventListener('click', event => {
  const button = event.target.closest('[data-queue-index]');
  if (!button) return;
  const order = pendingOrders[Number(button.dataset.queueIndex)];
  if (!order) return;
  websiteOrderInput.value = order.order_no || '';
  orderInput.value = order.xianyu_claim_no || '';
  amountInput.value = order.amount || '';
  showResult(`已选中 ${order.plan === 'single' ? '单次下载' : order.plan === 'basic' ? '19.8 会员' : '29.8 无限会员'}订单，请先到闲鱼卖家端确认确实到账`, false);
  document.querySelector('#websiteOrder').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

async function loadPendingOrders() {
  const secret = secretInput.value.trim();
  if (!secret) return showResult('请先填写后台密钥', true);
  loadPendingButton.disabled = true;
  loadPendingButton.textContent = '正在读取待核款申请…';
  try {
    const response = await fetch('/api/admin-confirm', { headers: { 'X-Admin-Secret': secret } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'LOAD_FAILED');
    pendingOrders = data.orders || [];
    pendingQueue.innerHTML = pendingOrders.length ? pendingOrders.map((order, index) => `
      <article>
        <div><b>${escapeText(order.plan === 'single' ? '单次下载 ¥2.98' : order.plan === 'basic' ? '向晴会员 ¥19.8' : '无限会员 ¥29.8')}</b><span>${escapeText(order.email || order.user_id)}</span><small>网站：${escapeText(order.order_no)}<br>闲鱼：${escapeText(order.xianyu_claim_no || '未填写')}</small></div>
        <button data-queue-index="${index}">选择核款</button>
      </article>`).join('') : '<p>暂时没有用户提交的待核款申请。</p>';
  } catch (error) {
    pendingQueue.innerHTML = `<p class="error">${error.message === 'INVALID_ADMIN_SECRET' ? '后台密钥不正确' : '读取失败，请稍后重试'}</p>`;
  } finally {
    loadPendingButton.disabled = false;
    loadPendingButton.textContent = '读取用户提交的待核款申请';
  }
}

confirmButton.addEventListener('click', async () => {
  const secret = secretInput.value.trim();
  const websiteOrderNo = websiteOrderInput.value.trim();
  const xianyuOrderNo = orderInput.value.trim();
  const paidAmount = amountInput.value.trim();
  if (!secret || websiteOrderNo.length < 10 || xianyuOrderNo.length < 6 || !/^\d+(\.\d{1,2})?$/.test(paidAmount)) {
    return showResult('请完整填写后台密钥、两个订单号和实付金额', true);
  }
  confirmButton.disabled = true;
  confirmButton.textContent = '正在核对并发放…';
  try {
    const response = await fetch('/api/admin-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': secret },
      body: JSON.stringify({ website_order_no: websiteOrderNo, xianyu_order_no: xianyuOrderNo, paid_amount: paidAmount })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'CONFIRMATION_FAILED');
    const order = data.order;
    resultBox.innerHTML = `<span>${data.idempotent ? '该订单之前已完成发放，没有重复增加权益' : '核款成功，权益已经发放'}</span><strong>${escapeText(order.order_no)}</strong><small>账号：${escapeText(order.email || order.user_id)} · 套餐：${escapeText(order.plan)} · ¥${escapeText(order.amount)} · 状态：已到账 / 已发放</small>`;
    resultBox.className = 'admin-result show';
    loadPendingOrders();
  } catch (error) {
    const messages = {
      INVALID_ADMIN_SECRET: '后台密钥不正确',
      ORDER_NOT_FOUND: '没有找到网站订单，请核对订单号',
      AMOUNT_MISMATCH: '实付金额与网站套餐金额不一致，禁止发放',
      XIANYU_ORDER_ALREADY_USED: '这个闲鱼订单号已经用于其他网站订单',
      ORDER_ALREADY_CONFIRMED: '这个网站订单已经绑定另一个闲鱼订单，不能重复或换单发放',
      INVALID_ORDER_STATUS: '网站订单状态不允许发放',
      CLAIM_MISMATCH: '填写的闲鱼订单号与用户提交的不一致'
    };
    showResult(messages[error.message] || '核款失败，请检查订单信息后重试', true);
  } finally {
    confirmButton.disabled = false;
    confirmButton.textContent = '确认闲鱼已收款，释放账号权益';
  }
});

function showResult(message, isError = false) {
  resultBox.textContent = message;
  resultBox.className = `admin-result show ${isError ? 'error' : ''}`;
}

function escapeText(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
