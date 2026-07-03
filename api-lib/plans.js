export const PLANS = Object.freeze({
  single: { id: 'single', amountCents: 298, amount: 2.98, name: '单次下载', grantText: 'Word/PDF 单次下载额度 × 1' },
  basic: { id: 'basic', amountCents: 1980, amount: 19.8, name: '向晴会员', grantText: '30 天会员 · 每周 35 次优化' },
  pro: { id: 'pro', amountCents: 2980, amount: 29.8, name: '向晴无限会员', grantText: '30 天无限会员' }
});

export function amountToCents(value) {
  const normalized = String(value ?? '').trim().replace(/[¥￥,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export function chinaDateKey(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function chinaWeekKey(date = new Date()) {
  const [year, month, day] = chinaDateKey(date).split('-').map(Number);
  const shanghaiDay = new Date(Date.UTC(year, month - 1, day));
  const mondayOffset = (shanghaiDay.getUTCDay() + 6) % 7;
  shanghaiDay.setUTCDate(shanghaiDay.getUTCDate() - mondayOffset);
  return shanghaiDay.toISOString().slice(0, 10);
}
