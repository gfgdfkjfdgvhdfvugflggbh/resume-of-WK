const secretInput = document.querySelector('#adminSecret');
const orderInput = document.querySelector('#xianyuOrder');
const planInput = document.querySelector('#orderPlan');
const resultBox = document.querySelector('#adminResult');
const generateButton = document.querySelector('#generateCode');

generateButton.addEventListener('click', async () => {
  const secret = secretInput.value.trim();
  const orderNo = orderInput.value.trim();
  if (!secret || orderNo.length < 6) return showResult('请填写后台密钥和正确的闲鱼订单号', true);
  generateButton.disabled = true;
  generateButton.textContent = '正在生成…';
  try {
    const response = await fetch('/api/admin/redemption-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': secret },
      body: JSON.stringify({ xianyu_order_no: orderNo, plan: planInput.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '生成失败');
    const item = data.redemption;
    resultBox.innerHTML = `<span>${data.idempotent ? '该订单已生成过兑换码' : '兑换码生成成功'}</span><strong>${item.code}</strong><small>订单：${escapeText(item.xianyu_order_no)} · 状态：${item.status}</small><button id="copyCode">复制兑换码</button>`;
    resultBox.className = 'admin-result show';
    document.querySelector('#copyCode').addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.code);
      document.querySelector('#copyCode').textContent = '已复制，可以发给买家';
    });
  } catch (error) {
    showResult(error.message === 'INVALID_ADMIN_SECRET' ? '后台密钥不正确' : '生成失败，请检查订单号后重试', true);
  } finally {
    generateButton.disabled = false;
    generateButton.textContent = '确认已收款，生成兑换码';
  }
});

function showResult(message, isError = false) {
  resultBox.textContent = message;
  resultBox.className = `admin-result show ${isError ? 'error' : ''}`;
}

function escapeText(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
