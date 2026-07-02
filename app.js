const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const helpDialog = document.querySelector('#helpDialog');
const backendMode = location.protocol === 'http:' || location.protocol === 'https:';
let authToken = localStorage.getItem('sunny-auth-token') || '';
let cachedServerOrders = [];
let paymentPollTimer = null;
let appConfig = {
  loaded: !backendMode,
  demoMode: !backendMode,
  auth: { sms: false, wechat: false, apple: false },
  directPaymentEnabled: false,
  xianyuItemUrl: '',
  xianyuItemUrls: {}
};

async function apiRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function normalizeServerUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    phone: user.phone || '',
    provider: user.provider,
    displayName: user.phone ? maskPhone(user.phone) : user.provider === 'wechat' ? '微信用户' : 'Apple 用户',
    freeCredits: Number(user.free_credits ?? user.freeCredits ?? 0),
    freeCreditDate: user.free_credit_date || user.freeCreditDate || chinaDateKey(),
    createdAt: Number(user.created_at || Date.now()) * (user.created_at ? 1000 : 1)
  };
}

function normalizeServerEntitlement(item) {
  if (!item) return { plan: 'none', credits: 0 };
  return {
    plan: item.plan || 'none',
    credits: Number(item.credits || 0),
    expiresAt: item.expires_at ? Number(item.expires_at) * 1000 : null,
    usageDate: item.usage_date || '',
    usageCount: Number(item.usage_count || 0)
  };
}

function normalizeServerOrder(order) {
  return {
    orderNo: order.order_no,
    userId: order.user_id,
    plan: order.plan,
    planName: plans[order.plan]?.name || order.plan,
    amount: Number(order.amount),
    method: order.method,
    methodName: order.method === 'wechat' ? '微信支付' : '支付宝',
    status: order.status,
    grantText: order.plan === 'single' ? '单次简历下载额度 × 1' : order.plan === 'basic' ? '30 天会员 · 每周 35 次优化额度' : '30 天无限会员 · 不限次数'
  };
}

async function syncServerSession() {
  if (!backendMode || !authToken) return false;
  try {
    const data = await apiRequest('/api/me');
    state.user = normalizeServerUser(data.user);
    state.entitlement = normalizeServerEntitlement(data.entitlement);
    cachedServerOrders = (data.orders || []).map(normalizeServerOrder);
    saveCurrentUser();
    updateAccountHeader();
    refreshDownloadUI();
    return true;
  } catch (error) {
    if (error.status === 401) {
      authToken = '';
      localStorage.removeItem('sunny-auth-token');
      state.user = null;
      state.entitlement = { plan: 'none', credits: 0 };
      updateAccountHeader();
    }
    return false;
  }
}

async function loadAppConfig() {
  if (!backendMode) return appConfig;
  try {
    const config = await apiRequest('/api/config');
    appConfig = { ...config, loaded: true };
  } catch (_) {
    appConfig = { loaded: true, demoMode: true, auth: { sms: false, wechat: false, apple: false } };
  }
  return appConfig;
}

const state = {
  view: 'landing',
  applicantType: '',
  file: null,
  rawResumeText: '',
  parsed: false,
  parseMode: 'pending',
  user: loadCurrentUser(),
  entitlement: null,
  form: {
    name: '', gender: '', age: '', phone: '', email: '', position: '', industry: '', jd: ''
  }
};

const plans = {
  single: { id: 'single', name: '单次下载', price: 2.98, unit: '次', note: 'Word 或 PDF 下载 1 次' },
  basic: { id: 'basic', name: '向晴会员', price: 19.8, unit: '月', note: '每周 35 次优化额度' },
  pro: { id: 'pro', name: '向晴无限会员', price: 29.8, unit: '月', note: '每天不限优化次数' }
};

if (backendMode && !authToken) state.user = null;
state.entitlement = loadEntitlement(state.user?.id);

let paymentState = { plan: 'single', method: 'wechat', stage: 'choose', orderNo: '', qrCode: '', demo: !backendMode, downloadFormat: 'word' };
let pendingAfterLogin = null;
let loginState = { stage: 'phone', phone: '', sentCode: '', error: '' };

const icons = {
  graduate: '🎓', experienced: '🧭', upload: '↥'
};

function loadCurrentUser() {
  try {
    const userId = localStorage.getItem('sunny-current-user');
    const user = userId ? JSON.parse(localStorage.getItem(`sunny-user-${userId}`)) : null;
    if (user && ['wechat', 'apple'].includes(user.provider) && /^(wechat|apple)_/.test(user.id)) {
      localStorage.removeItem('sunny-current-user');
      return null;
    }
    if (user && !backendMode) refreshLocalDailyCredits(user);
    return user;
  } catch (_) {
    return null;
  }
}

function saveCurrentUser() {
  if (!state.user) return;
  localStorage.setItem('sunny-current-user', state.user.id);
  localStorage.setItem(`sunny-user-${state.user.id}`, JSON.stringify(state.user));
}

function updateAccountHeader() {
  const button = document.querySelector('#accountButton');
  const quota = document.querySelector('#quotaPill');
  if (!button || !quota) return;
  if (!state.user) {
    button.textContent = '登录 / 注册';
    quota.textContent = '登录后每天享 3 次免费下载';
    quota.className = 'quota-pill';
    return;
  }
  button.textContent = state.user.displayName || maskPhone(state.user.phone) || '我的账号';
  const access = getDownloadAccess();
  quota.textContent = state.user.freeCredits > 0 ? `今日免费额度 ${state.user.freeCredits} 次` : (access.allowed ? access.description : '今日免费额度已用完');
  quota.className = `quota-pill ${state.user.freeCredits > 0 ? 'has-credit' : ''}`;
}

function maskPhone(phone = '') {
  return phone ? phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '';
}

function chinaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function refreshLocalDailyCredits(user) {
  const today = chinaDateKey();
  if (user.freeCreditDate !== today) {
    user.freeCredits = 3;
    user.freeCreditDate = today;
    localStorage.setItem(`sunny-user-${user.id}`, JSON.stringify(user));
  }
  return user;
}

function saveDraft() {
  localStorage.setItem('sunny-resume-draft', JSON.stringify({
    applicantType: state.applicantType,
    form: { ...state.form, position: '', industry: '', jd: '' }
  }));
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem('sunny-resume-draft'));
    if (draft) {
      state.applicantType = draft.applicantType || '';
      state.form = { ...state.form, ...(draft.form || {}) };
      state.form.position = '';
      state.form.industry = '';
      state.form.jd = '';
    }
  } catch (_) {}
  state.form.position = '';
  state.form.industry = '';
  state.form.jd = '';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function renderLanding() {
  state.view = 'landing';
  app.innerHTML = `
    <section class="landing">
      <div class="hero-copy">
        <span class="eyebrow">不同阶段，不同改法</span>
        <h1>不是重写你，<br>是让经历<br><em>更适合此刻。</em></h1>
        <p class="hero-lead">校招可以重新组织项目与实习，突出潜力；社招则要尊重多年积累，只微调表达与重点。先确认求职阶段，才能决定简历该“重构”还是“微雕”。</p>
        <div class="comfort-note">
          <div class="comfort-avatars"><span>🌱</span><span>☁️</span><span>✨</span></div>
          <span><b>不用独自琢磨</b>，我们陪你把这一步走稳。</span>
        </div>
      </div>
      <div class="choice-panel">
        <span class="step-count">START · 先认识你</span>
        <h2>先选择你的求职阶段</h2>
        <p>这会决定修改尺度，不只是换一套称呼。</p>
        <div class="path-options">
          <button class="path-card ${state.applicantType === 'graduate' ? 'selected' : ''}" data-type="graduate">
            <span class="path-icon">${icons.graduate}</span>
            <span><strong>校招 / 应届生</strong><small>允许较大调整结构，深挖实习、校园项目和成长潜力</small><span class="strategy-chips"><i>可重构</i><i>突出潜力</i><i>深挖实习</i></span></span>
            <span class="path-arrow">→</span>
          </button>
          <button class="path-card ${state.applicantType === 'experienced' ? 'selected' : ''}" data-type="experienced">
            <span class="path-icon">${icons.experienced}</span>
            <span><strong>社招 / 职场人</strong><small>保留职业轨迹与事实，只把已有工作微雕得更贴合 JD</small><span class="strategy-chips"><i>不改主干</i><i>微调重点</i><i>匹配 JD</i></span></span>
            <span class="path-arrow">→</span>
          </button>
        </div>
        <div class="trust-strip"><span>✓ 隐私保护</span><span>✓ Word 可编辑</span><span>✓ 约 2 分钟</span></div>
      </div>
    </section>`;

  app.querySelectorAll('[data-type]').forEach(button => {
    button.addEventListener('click', () => {
      state.applicantType = button.dataset.type;
      saveDraft();
      renderImport();
    });
  });
}

function renderImport() {
  state.view = 'import';
  app.innerHTML = `
    <section class="workspace import-workspace">
      <div class="progress-wrap">
        <button class="back-link" data-action="back-home">← 返回选择身份</button>
        <div class="progress">${progressHTML(1)}</div><span></span>
      </div>
      <div class="import-card">
        <div class="import-copy">
          <span class="eyebrow">先从你的简历开始</span>
          <h1>不用重复填写，<br>我先来读懂你。</h1>
          <p>上传现有简历后，我会自动提取姓名、年龄、联系方式和经历。识别有偏差也没关系，下一步都能手动修改。</p>
          <div class="parse-preview">
            <span>自动识别</span><b>姓名</b><b>年龄</b><b>联系方式</b><b>教育经历</b><b>工作项目</b>
          </div>
        </div>
        <div class="import-upload">
          <div class="upload-zone upload-zone-large" id="uploadZone">
            <input id="resumeFile" type="file" accept=".doc,.docx,.pdf,.txt">
            <span class="upload-symbol">${icons.upload}</span>
            <span><strong>上传你的现有简历</strong><small>点击选择或拖入 Word、PDF、TXT 文件<br>文件最大 10MB</small></span>
            <em>选择文件</em>
          </div>
          <div class="privacy-card"><span>🔒</span><p><b>你的简历属于你</b><br>仅用于本次解析与优化，不用于公开展示。</p></div>
        </div>
      </div>
    </section>`;
  app.querySelector('[data-action="back-home"]').addEventListener('click', renderLanding);
  bindUpload();
}

function progressHTML(active = 2) {
  const labels = ['读取简历', '确认信息', 'AI 优化', '完成'];
  return labels.map((label, i) => {
    const n = i + 1;
    const cls = n === active ? 'active' : n < active ? 'done' : '';
    return `<div class="progress-step ${cls}"><span>${n < active ? '✓' : n}</span>${label}</div>`;
  }).join('');
}

function renderForm() {
  state.view = 'form';
  const isGraduate = state.applicantType === 'graduate';
  const extractedByBrowser = state.parseMode === 'client';
  const autoTag = extractedByBrowser ? '<em>自动识别</em>' : '<em class="verify-tag">请确认</em>';
  app.innerHTML = `
    <section class="workspace">
      <div class="progress-wrap">
        <button class="back-link" data-action="back">← 重新上传简历</button>
        <div class="progress">${progressHTML(2)}</div><span></span>
      </div>
      <div class="form-shell">
        <form class="form-main" id="resumeForm">
          <div class="form-heading">
            <div><span class="eyebrow">${extractedByBrowser ? '已完成简历识别' : '已收到你的原始简历'}</span><h1>这些信息对吗？</h1><p>${extractedByBrowser ? '我已经帮你填好了，请快速确认。识别不准的地方，直接修改就可以。' : '当前前端原型不虚构 Word / PDF 的读取结果；接入后端解析后会自动填充，现在可以先手动确认。'}</p></div>
            <span class="path-tag">${isGraduate ? '🎓 校招模式' : '🧭 社招模式'}</span>
          </div>

          <div class="extract-success ${extractedByBrowser ? '' : 'extract-pending'}"><span>${extractedByBrowser ? '✓' : '!'}</span><p><b>${extractedByBrowser ? `已从「${escapeHTML(state.file?.name || '你的简历')}」提取信息` : `已保留「${escapeHTML(state.file?.name || '你的简历')}」原文件`}</b><br>${extractedByBrowser ? '带有“自动识别”标记的内容，请重点确认一下。' : 'Word / PDF 解析接口尚未接入，因此不会用虚构信息替你填写。'}</p></div>

          <h2 class="section-title"><span>1</span> 基本信息</h2>
          <div class="field-grid three">
            <div class="field ${extractedByBrowser ? 'extracted' : ''}"><label>姓名 <i class="required">*</i>${autoTag}</label><input name="name" value="${escapeHTML(state.form.name)}" placeholder="你的姓名" required></div>
            <div class="field"><label>性别</label><select name="gender"><option value="">请选择</option><option ${state.form.gender === '女' ? 'selected' : ''}>女</option><option ${state.form.gender === '男' ? 'selected' : ''}>男</option><option ${state.form.gender === '不透露' ? 'selected' : ''}>不透露</option></select></div>
            <div class="field ${extractedByBrowser ? 'extracted' : ''}"><label>年龄 ${autoTag}</label><input name="age" type="number" min="16" max="70" value="${escapeHTML(state.form.age)}" placeholder="例如 24"></div>
          </div>
          <div class="field-grid contact-grid">
            <div class="field ${extractedByBrowser ? 'extracted' : ''}"><label>手机 ${autoTag}</label><input name="phone" value="${escapeHTML(state.form.phone)}" placeholder="你的手机号码"></div>
            <div class="field ${extractedByBrowser ? 'extracted' : ''}"><label>邮箱 ${autoTag}</label><input name="email" value="${escapeHTML(state.form.email)}" placeholder="你的常用邮箱"></div>
          </div>

          <h2 class="section-title"><span>2</span> 求职方向</h2>
          <div class="field-grid">
            <div class="field"><label>目标职位 <i class="required">*</i></label><input name="position" value="${escapeHTML(state.form.position)}" placeholder="例如：产品经理" required></div>
            <div class="field"><label>目标行业</label><input name="industry" value="${escapeHTML(state.form.industry)}" placeholder="例如：互联网 / 新能源"></div>
          </div>

          <h2 class="section-title"><span>3</span> 粘贴目标岗位 JD</h2>
          <div class="field full"><label>岗位描述 <i class="required">*</i></label><textarea name="jd" placeholder="把招聘平台上的岗位职责、任职要求粘贴到这里。越完整，优化越精准。" required>${escapeHTML(state.form.jd)}</textarea></div>

          <div class="form-actions">
            <span class="form-hint">🔒 资料仅用于本次优化</span>
            <button class="primary-button" type="submit">开始理解并优化 <span class="arrow">→</span></button>
          </div>
        </form>

        <aside class="side-note">
          <div class="note-illustration"><div class="sun"></div><div class="hill"></div><div class="little-person">🧘</div></div>
          <span class="eyebrow">Take it easy</span>
          <h3>求职不是一场自我审判</h3>
          <p>一次没回复，不代表你的价值没有被看见。我们先把能做的这一步做扎实，剩下的交给时间和机会。</p>
          <hr class="tiny-rule">
          <div class="side-check"><div><i>✓</i> 理解真实项目与能力</div><div><i>✓</i> 对照 JD 提炼关键词</div><div><i>✓</i> 不编造任何经历</div></div>
        </aside>
      </div>
    </section>`;

  const form = document.querySelector('#resumeForm');
  form.addEventListener('input', event => {
    if (event.target.name) {
      state.form[event.target.name] = event.target.value;
      saveDraft();
    }
  });
  form.addEventListener('submit', submitForm);
  app.querySelector('[data-action="back"]').addEventListener('click', renderImport);
}

function bindUpload() {
  const input = document.querySelector('#resumeFile');
  const zone = document.querySelector('#uploadZone');
  input.addEventListener('change', () => handleFile(input.files[0]));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragging'); handleFile(e.dataTransfer.files[0]); });
  const remove = zone.querySelector('[data-action="remove-file"]');
  if (remove) remove.addEventListener('click', e => { e.stopPropagation(); state.file = null; renderForm(); });
}

function handleFile(file) {
  if (!file) return;
  const allowed = ['doc', 'docx', 'pdf', 'txt'];
  const ext = file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) return showToast('请上传 Word、PDF 或 TXT 文件');
  if (file.size > 10 * 1024 * 1024) return showToast('文件请控制在 10MB 以内');
  state.file = file;
  ['name', 'age', 'phone', 'email'].forEach(key => state.form[key] = '');
  parseResume(file);
}

async function parseResume(file) {
  state.view = 'parsing';
  app.innerHTML = `
    <section class="loading-page compact-loading">
      <div class="loading-card">
        <div class="loading-art"><div class="loading-ring"></div><div class="loading-center">📄</div></div>
        <span class="eyebrow">正在读取 ${escapeHTML(file.name)}</span>
        <h1>我在认识你的经历</h1>
        <p id="parseStatus">正在识别基本信息、教育背景和工作项目…</p>
      </div>
    </section>`;

  let text = '';
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'txt') text = await file.text();
    if (ext === 'docx' && window.mammoth) {
      document.querySelector('#parseStatus').textContent = '正在读取 Word 段落、个人信息与经历…';
      const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      text = result.value;
    }
    if (ext === 'pdf' && window.pdfjsLib) {
      document.querySelector('#parseStatus').textContent = '正在逐页读取 PDF 内容，这可能需要几秒…';
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', window.location.href).href;
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = [];
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
        const page = await pdf.getPage(pageNo);
        const content = await page.getTextContent();
        const rows = new Map();
        content.items.forEach(item => {
          const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
          if (!rows.has(y)) rows.set(y, []);
          rows.get(y).push({ x: item.transform?.[4] || 0, text: item.str });
        });
        const pageText = [...rows.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) => items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
          .join('\n');
        pages.push(pageText);
      }
      text = pages.join('\n\n');
    }
  } catch (error) {
    console.warn('Resume parsing failed:', error);
  }
  state.rawResumeText = text;
  state.parseMode = text.trim() ? 'client' : 'pending';
  extractBasicInfo(text);
  setTimeout(() => {
    state.parsed = true;
    saveDraft();
    renderForm();
    showToast('简历读取完成，请确认识别结果');
  }, 1300);
}

function extractBasicInfo(text) {
  const source = (text || '').replace(/\r/g, '\n');
  const normalized = source.replace(/[\t\u00a0]+/g, ' ').replace(/ +/g, ' ');
  const phone = normalized.match(/1[3-9]\d{9}/)?.[0];
  const email = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const explicitAge = normalized.match(/(?:年龄|年纪)[：:\s]*(1[6-9]|[2-6]\d)(?:岁)?/)?.[1]
    || normalized.match(/(?:^|[\s，,；;])((?:1[6-9]|[2-6]\d))\s*岁(?:[\s，,；;]|$)/)?.[1];
  const birthYear = normalized.match(/(?:出生年月|出生日期|出生|生日)[：:\s]*(19\d{2}|20\d{2})(?:[.\-/年]\d{1,2})?/)?.[1];
  const calculatedAge = birthYear ? Math.max(16, new Date().getFullYear() - Number(birthYear)) : '';

  const explicitName = normalized.match(/(?:姓名|姓\s*名)[：:\s]*([\u4e00-\u9fa5·]{2,4})(?=\s|[，,|｜;；]|性别|年龄|$)/)?.[1];
  const nameStopWords = /个人简历|求职简历|简历|求职意向|联系方式|个人信息|基本信息|教育经历|工作经历|项目经历|实习经历|自我评价|专业技能|产品经理|运营经理|软件工程|市场营销|联系电话|手机号码|电子邮箱|出生年月|政治面貌|现居住地|应聘岗位/;
  const lineCandidates = source.split(/\n+/).slice(0, 14).map(line => line.trim()).filter(Boolean);
  let inferredName = '';
  for (const line of lineCandidates) {
    const compact = line.replace(/[\s|｜·•]+/g, ' ').trim();
    const direct = compact.match(/^([\u4e00-\u9fa5]{2,4})(?:\s|$)/)?.[1];
    if (direct && !nameStopWords.test(direct) && !/大学|学院|公司|岗位|专业/.test(direct)) {
      inferredName = direct;
      break;
    }
  }
  if (!inferredName) {
    const headTokens = normalized.slice(0, 220).match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    inferredName = headTokens.find(token => !nameStopWords.test(token) && !/大学|学院|公司|岗位|专业|电话|邮箱|性别|年龄/.test(token)) || '';
  }

  if (explicitName || inferredName) state.form.name = explicitName || inferredName;
  if (explicitAge || calculatedAge) state.form.age = String(explicitAge || calculatedAge);
  if (phone) state.form.phone = phone;
  if (email) state.form.email = email;
}

function submitForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  Object.keys(state.form).forEach(key => state.form[key] = data.get(key) || '');
  saveDraft();
  if (!state.file) return showToast('还需要上传一份现有简历');
  if (state.form.jd.trim().length < 30) return showToast('岗位 JD 再完整一点，至少 30 个字');
  renderLoading();
}

function renderLoading() {
  state.view = 'loading';
  app.innerHTML = `
    <section class="loading-page">
      <div class="loading-card">
        <div class="loading-art"><div class="loading-ring"></div><div class="loading-center">🌤️</div></div>
        <span class="eyebrow">正在认真阅读</span>
        <h1>稍等，我正在把经历讲得更好</h1>
        <p>不是简单替换关键词。我会先理解你做过什么、擅长什么，再对照岗位找到最值得强调的部分。</p>
        <div class="loading-list">
          <div class="loading-item active" data-load="0"><b>1</b><span>读取并梳理原始简历</span></div>
          <div class="loading-item" data-load="1"><b>2</b><span>识别项目、职责与核心能力</span></div>
          <div class="loading-item" data-load="2"><b>3</b><span>分析岗位 JD 与匹配关键词</span></div>
          <div class="loading-item" data-load="3"><b>4</b><span>重写专业表达并检查真实性</span></div>
        </div>
      </div>
    </section>`;

  let current = 0;
  const interval = setInterval(() => {
    const items = [...document.querySelectorAll('.loading-item')];
    if (!items.length) return clearInterval(interval);
    items[current].classList.remove('active');
    items[current].classList.add('done');
    items[current].querySelector('b').textContent = '✓';
    current += 1;
    if (current < items.length) items[current].classList.add('active');
    else {
      clearInterval(interval);
      setTimeout(renderResult, 650);
    }
  }, 760);
}

function renderResult() {
  state.view = 'result';
  const name = state.form.name || '林晓晴';
  const position = state.form.position || '产品经理';
  const industry = state.form.industry || '互联网';
  const isGraduate = state.applicantType === 'graduate';
  const strategyName = isGraduate ? '校招重构模式' : '社招微雕模式';
  const strategyCopy = isGraduate ? '重点深挖实习与项目，不受工作年限限制' : '保留公司、岗位、时间与职责主干，只调整表达侧重点';
  const access = getDownloadAccess();
  app.innerHTML = `
    <section class="result-shell">
      <div class="progress-wrap">
        <button class="back-link" data-action="edit-form">← 修改信息</button>
        <div class="progress">${progressHTML(4)}</div><span></span>
      </div>
      <div class="success-banner">
        <div><div class="strategy-result-tag">${isGraduate ? '🎓' : '🧭'} ${strategyName}</div><h1>优化完成，你离心仪岗位又近了一点 ✨</h1><p>${strategyCopy}。当前为交互原型，接入 AI 接口后优化内容将严格取自原简历。</p></div>
        <div class="match-score"><strong>86%</strong><small>岗位匹配度</small></div>
      </div>
      <div class="download-dock">
        <div class="download-dock-copy"><span class="word-badge">↓</span><p><b>2 页专业版简历已生成</b><small>Word 可继续编辑 · PDF 适合直接投递</small></p></div>
        <div class="download-dock-action"><span>${access.allowed ? access.description : '选择需要的格式，生成后可直接使用'}</span><div class="download-format-buttons"><button class="primary-button download-primary word-download" data-action="download" data-format="word">下载 Word</button><button class="primary-button download-primary pdf-download" data-action="download" data-format="pdf">下载 PDF</button></div></div>
      </div>
      <div class="download-status" id="downloadStatus" aria-live="polite"></div>
      <div class="result-grid">
        <aside class="analysis-panel">
          <h2>这次重点优化了什么</h2>
          <div class="strategy-boundary ${isGraduate ? 'graduate-boundary' : 'social-boundary'}"><b>${strategyName}</b><p>${isGraduate ? '可调整模块顺序、重组项目描述、深挖重要实习；不编造项目和数据。' : '公司、职位、时间、业务事实不动；只调整措辞、信息顺序和与 JD 相关的强调点。'}</p></div>
          <div class="analysis-block"><div class="analysis-label"><span>岗位关键词覆盖</span><span>88%</span></div><div class="meter"><i style="width:88%"></i></div></div>
          <div class="analysis-block"><div class="analysis-label"><span>经历表达清晰度</span><span>92%</span></div><div class="meter"><i style="width:92%;background:#e8b95f"></i></div></div>
          <div class="analysis-block"><div class="analysis-label"><span>已强化关键词</span></div><div class="keyword-list"><span class="keyword">需求洞察</span><span class="keyword">跨团队协作</span><span class="keyword">数据分析</span><span class="keyword">项目落地</span><span class="keyword">用户增长</span></div></div>
          <div class="change-legend"><b>颜色怎么看？</b><span><i class="legend-rewrite"></i>重写得更专业</span><span><i class="legend-added"></i>补充能力总结</span><span><i class="legend-keyword"></i>强化 JD 关键词</span></div>
          <div class="analysis-tip"><b>表达原则</b><br>我们只帮你把真实经历说清楚，不虚构数字、不夸大职责。面试时，你依然可以自信地讲出每一句。</div>
        </aside>
        <div class="resume-panel">
          <div class="resume-toolbar">
            <strong>优化版简历 · 共 2 页 · 可直接点击正文修改</strong>
            <div class="toolbar-actions"><button class="tool-button compare" data-action="compare">⇄ 左右对比</button><button class="tool-button" data-action="copy">复制全文</button><button class="tool-button download" data-action="download" data-format="word">Word</button><button class="tool-button pdf-tool" data-action="download" data-format="pdf">PDF</button></div>
          </div>
          <div class="resume-document" id="resumePaper" contenteditable="true" spellcheck="false">
            <article class="resume-paper resume-page">
              <div class="page-number">01 / 02</div>
              <div class="resume-head"><div><h1>${escapeHTML(name)}</h1><p>求职意向：${escapeHTML(position)}</p></div><div class="resume-contact">${state.form.gender ? escapeHTML(state.form.gender) + ' · ' : ''}${state.form.age ? escapeHTML(state.form.age) + ' 岁<br>' : ''}${escapeHTML(state.form.phone || '138-0000-0000')}<br>${escapeHTML(state.form.email || 'hello@example.com')}</div></div>
              <section class="resume-section"><h2>个人优势 PROFILE</h2><p><span class="change-added" title="AI 新增的能力总结">具备从用户需求洞察到方案落地的完整项目经验，能够结合业务目标拆解问题，</span><span class="change-keyword" title="根据 JD 强化的关键词">通过数据分析验证方向并推动跨团队协作。</span><span class="change-added" title="AI 新增的能力总结">关注用户价值与执行效率，善于在复杂信息中快速识别关键问题，致力于在${escapeHTML(industry)}领域持续创造可衡量的业务成果。</span></p><small class="change-reason reason-added">＋ 修改原因：把分散在经历中的能力归纳成开场总结，让招聘者先看到你的核心优势。</small></section>
              <section class="resume-section"><h2>核心能力 CORE COMPETENCIES</h2><div class="competency-grid"><span>用户研究与需求洞察</span><span>产品策略与方案设计</span><span>数据分析与效果复盘</span><span>跨团队项目推进</span><span>用户增长与精细运营</span><span>结构化表达与沟通</span></div></section>
              <section class="resume-section"><h2>工作经历 EXPERIENCE</h2>
                <div class="experience"><div class="experience-title"><strong>某科技公司 · 产品运营</strong><span>2023.07 — 至今</span></div><h3>用户增长与产品体验优化</h3><ul><li><span class="change-rewrite" title="基于原经历重写">围绕核心用户路径开展需求调研与行为数据分析，识别 3 个关键转化阻塞点，</span><span class="change-keyword" title="根据 JD 强化的关键词">协同产品、设计与研发推动方案落地。</span><small class="change-reason reason-keyword">◎ 修改原因：JD 强调“跨团队协作与项目落地”，保留原职责，调整表述重点以提高匹配度。</small></li><li><span class="change-rewrite" title="基于原经历重写">搭建用户反馈分类机制，将分散建议沉淀为可跟踪的需求池，需求响应效率提升 35%。</span><small class="change-reason reason-rewrite">✦ 修改原因：从“做了什么”改成“动作＋方法＋结果”，更清楚地体现个人贡献。</small></li><li><span class="change-rewrite" title="基于原经历重写">负责新功能上线运营，制定分层触达策略并复盘效果，带动目标功能使用率持续提升。</span><small class="change-reason reason-rewrite">✦ 修改原因：突出策略与复盘能力，弱化泛泛的“负责运营”。</small></li><li>定期跟踪用户留存、功能渗透率与反馈闭环情况，输出周度复盘，为后续产品迭代提供决策依据。</li></ul></div>
                <div class="experience"><div class="experience-title"><strong>某互联网公司 · 产品实习生</strong><span>2022.10 — 2023.05</span></div><h3>需求分析与版本协作</h3><ul><li>参与用户访谈、竞品研究及需求文档撰写，协助完成多个版本从评审到上线验收的全过程。</li><li>整理客服、社群和应用商店反馈，按影响范围及紧急程度进行分类，持续维护需求优先级。</li></ul></div>
              </section>
            </article>
            <div class="page-break-label"><span>第 2 页</span></div>
            <article class="resume-paper resume-page">
              <div class="page-number">02 / 02</div>
              <div class="resume-page-title"><b>${escapeHTML(name)}</b><span>${escapeHTML(position)} · 详细项目与能力证明</span></div>
              <section class="resume-section"><h2>重点项目 PROJECTS</h2>
                <div class="experience"><div class="experience-title"><strong>核心功能使用率提升项目 · 项目负责人</strong><span>2023.11 — 2024.03</span></div><h3>目标：改善新用户对核心功能的认知与使用深度</h3><ul><li><span class="change-rewrite">结合用户行为漏斗、访谈及客服反馈定位关键流失环节，形成“认知—尝试—留存”三阶段问题地图。</span><small class="change-reason reason-rewrite">✦ 修改原因：补充分析方法与工作路径，证明结论不是凭感觉得出。</small></li><li><span class="change-keyword">推动产品、设计、研发及运营共同完成方案评审，拆解埋点、产品改版和用户触达任务，按节点跟进交付。</span><small class="change-reason reason-keyword">◎ 修改原因：对应 JD 的跨部门推动、项目管理与落地能力。</small></li><li>上线后持续跟踪功能点击率、完成率与次日留存变化，基于数据表现完成两轮策略迭代并沉淀复盘文档。</li></ul></div>
                <div class="experience"><div class="experience-title"><strong>用户反馈闭环机制建设 · 核心成员</strong><span>2023.08 — 2023.12</span></div><h3>目标：提升高价值反馈的发现与响应效率</h3><ul><li>统一来自客服、社群、问卷和访谈的反馈口径，制定问题标签、影响范围、优先级和处理状态字段。</li><li><span class="change-rewrite">建立双周需求评审与结果回传机制，使用户声音从零散记录转为可追踪、可复盘的产品输入。</span><small class="change-reason reason-rewrite">✦ 修改原因：突出机制建设能力，而非停留在“整理反馈”的执行层。</small></li><li>定期输出用户洞察专题，为版本规划和运营触达提供事实依据，并持续追踪重点问题的解决情况。</li></ul></div>
                <div class="experience"><div class="experience-title"><strong>校园创新项目 · 核心成员</strong><span>2022.03 — 2022.09</span></div><h3>用户研究、方案验证与团队推进</h3><ul><li>围绕目标人群完成问卷设计、深度访谈和竞品分析，提炼核心使用场景与高频痛点。</li><li><span class="change-keyword">协调 5 人团队明确分工和关键节点，按期完成从概念验证、方案迭代到成果展示的全流程。</span><small class="change-reason reason-keyword">◎ 修改原因：强化项目推进关键词，同时保留原项目规模与角色边界。</small></li></ul></div>
              </section>
              <section class="resume-section"><h2>教育经历 EDUCATION</h2><div class="experience-title"><strong>某某大学 · 本科 · 市场营销</strong><span>2019.09 — 2023.06</span></div><p class="detail-line">主修课程：消费者行为学、市场调研、统计分析、数字营销、项目管理　·　相关荣誉：校级奖学金 / 优秀项目成员</p></section>
              <section class="resume-section"><h2>专业技能 SKILLS</h2><div class="skills-list"><p><b>数据与分析：</b>Excel（数据透视、常用函数）、SQL 基础查询、数据可视化与业务指标拆解</p><p><b>产品与协作：</b>Axure、Figma、飞书、Notion、需求文档、项目排期与复盘</p><p><b>语言与证书：</b>英语 CET-6，具备英文资料阅读与基础沟通能力</p></div></section>
              <section class="resume-section"><h2>自我评价 SUMMARY</h2><p>对用户需求与业务目标保持敏感，习惯先厘清问题、再组织资源推进解决。能够在多人协作中主动同步风险、明确下一步行动，并通过数据和用户反馈验证结果。期待在${escapeHTML(industry)}领域继续积累产品判断与项目落地能力。</p></section>
            </article>
          </div>
          <p class="edit-note">正文已开启编辑，修改后再下载即可。别担心，你不会把它弄坏。</p>
        </div>
      </div>
    </section>`;

  app.querySelector('[data-action="edit-form"]').addEventListener('click', renderForm);
  app.querySelector('[data-action="compare"]').addEventListener('click', openComparison);
  app.querySelector('[data-action="copy"]').addEventListener('click', copyResume);
  app.querySelectorAll('[data-action="download"]').forEach(button => button.addEventListener('click', () => requestDownload(button.dataset.format || 'word')));
}

function openComparison() {
  const optimizedHTML = document.querySelector('#resumePaper')?.innerHTML || '';
  const originalFileUrl = state.file ? URL.createObjectURL(state.file) : '';
  const originalPreview = buildOriginalPreview(originalFileUrl);
  const overlay = document.createElement('div');
  overlay.className = 'compare-overlay';
  overlay.innerHTML = `
    <div class="compare-dialog" role="dialog" aria-modal="true" aria-label="简历修改前后对比">
      <div class="compare-head">
        <div><span class="eyebrow">Before & After</span><h2>每一处修改，都看得见</h2></div>
        <div class="compare-head-actions"><div class="compare-legend"><span><i class="legend-rewrite"></i>专业重写</span><span><i class="legend-added"></i>新增总结</span><span><i class="legend-keyword"></i>JD 关键词</span></div><button data-action="close-compare" aria-label="关闭对比">×</button></div>
      </div>
      <div class="compare-body">
        <section class="compare-column original-column"><div class="compare-label"><b>你上传的原始简历</b><span>${escapeHTML(state.file?.name || '原文件')} · 未作改动</span></div>${originalPreview}</section>
        <div class="compare-divider"><span>→</span></div>
        <section class="compare-column optimized-column"><div class="compare-label"><b>根据 JD 优化后</b><span>彩色区域为调整内容</span></div><div class="mini-resume optimized-live-copy">${optimizedHTML}</div></section>
      </div>
      <div class="compare-foot"><span>共优化 <b>8</b> 处表达，补充 <b>5</b> 个岗位关键词</span><button class="primary-button" data-action="close-compare">看起来不错，继续编辑</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const closeComparison = () => {
    overlay.remove();
    if (originalFileUrl) URL.revokeObjectURL(originalFileUrl);
  };
  overlay.querySelectorAll('[data-action="close-compare"]').forEach(btn => btn.addEventListener('click', closeComparison));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeComparison(); });
}

function buildOriginalPreview(fileUrl) {
  if (!state.file) return '<div class="original-empty">没有找到原始简历，请返回重新上传。</div>';
  const ext = state.file.name.split('.').pop().toLowerCase();
  if (state.rawResumeText.trim()) {
    return `<div class="mini-resume original-text-resume"><div class="original-source-note">✓ 以下文字真实提取自用户上传的 ${ext.toUpperCase()} 原件</div><pre>${escapeHTML(state.rawResumeText)}</pre>${ext === 'pdf' ? `<a class="original-layout-link" href="${fileUrl}" target="_blank" rel="noopener">查看原始 PDF 排版 ↗</a>` : ''}</div>`;
  }
  return `<div class="mini-resume word-original"><div class="word-file-icon">W</div><h3>${escapeHTML(state.file.name)}</h3><p>这是用户实际上传的 Word 原件，没有使用任何虚构示例替代。</p><p>浏览器无法直接渲染 Word 排版；接入后端解析服务后，这里会逐段展示真实原文。</p><a class="original-download" href="${fileUrl}" download="${escapeHTML(state.file.name)}">打开 / 下载原始文件</a></div>`;
}

async function copyResume() {
  const text = document.querySelector('#resumePaper').innerText;
  try { await navigator.clipboard.writeText(text); showToast('已复制到剪贴板'); }
  catch (_) { showToast('请手动选择正文复制'); }
}

async function openLoginModal() {
  await loadAppConfig();
  if (backendMode && authToken) await syncServerSession();
  loginState = { stage: state.user ? 'account' : 'phone', phone: '', sentCode: '', error: '' };
  const overlay = document.createElement('div');
  overlay.className = 'login-overlay';
  overlay.id = 'loginOverlay';
  document.body.appendChild(overlay);
  renderLoginModal();
}

function renderLoginModal() {
  const overlay = document.querySelector('#loginOverlay');
  if (!overlay) return;
  const testAuth = appConfig.demoMode || !backendMode;
  const smsReady = Boolean(appConfig.auth?.sms) || testAuth;
  if (loginState.stage === 'phone') {
    overlay.innerHTML = `
      <section class="login-sheet" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
        <button class="payment-close" data-login-action="close" aria-label="关闭登录">×</button>
        <div class="login-brand"><span class="brand-mark">晴</span><b>向晴简历</b></div>
        ${testAuth ? '<div class="auth-mode-warning">测试账号模式 · 不代表已验证真实身份</div>' : ''}
        <h2 id="loginTitle">${testAuth ? '使用测试账号体验登录' : '登录后，每天领取 3 次免费下载'}</h2>
        <p class="login-lead">${testAuth ? '仍需输入手机号和验证码两步确认；测试数据只用于本机联调。' : '账号用于保存免费额度、订单和会员权益。换设备登录，权益也能跟着你。'}</p>
        <label class="login-field ${loginState.error ? 'has-error' : ''}"><span>${testAuth ? '测试账号手机号' : '手机号码'}</span><div><span>+86</span><input id="loginPhone" inputmode="numeric" maxlength="11" value="${escapeHTML(loginState.phone)}" placeholder="请输入 11 位手机号码" ${smsReady ? '' : 'disabled'}></div></label>
        ${loginState.error ? `<div class="login-inline-error">⚠ ${escapeHTML(loginState.error)}</div>` : ''}
        <button class="login-primary" data-login-action="send-code" ${smsReady ? '' : 'disabled'}>${testAuth ? '获取测试验证码' : smsReady ? '获取短信验证码' : '短信登录待接入'}</button>
        <div class="login-divider"><span>或使用快捷方式登录</span></div>
        <div class="social-login"><button ${appConfig.auth?.wechat ? 'data-provider="wechat"' : 'disabled'}><span class="wechat-icon">微</span><span>微信登录<small>${appConfig.auth?.wechat ? '' : '待接入'}</small></span></button><button ${appConfig.auth?.apple ? 'data-provider="apple"' : 'disabled'}><span class="apple-icon">●</span><span>Apple ID<small>${appConfig.auth?.apple ? '' : '待接入'}</small></span></button></div>
        <p class="login-terms">${testAuth ? '当前不会调用微信或 Apple，也不会把点击按钮视为真实登录。' : '登录即表示同意《用户协议》和《隐私政策》。'}</p>
      </section>`;
  }
  if (loginState.stage === 'code') {
    overlay.innerHTML = `
      <section class="login-sheet code-sheet" role="dialog" aria-modal="true" aria-labelledby="codeTitle">
        <button class="payment-close" data-login-action="close" aria-label="关闭登录">×</button>
        <button class="pay-back" data-login-action="back">← 修改手机号</button>
        <div class="sms-illustration">•••</div>
        <h2 id="codeTitle">输入${testAuth ? '测试' : '手机'}验证码</h2>
        <p class="login-lead">验证码已发送至 +86 ${maskPhone(loginState.phone)}</p>
        <input class="code-input ${loginState.error ? 'has-error' : ''}" id="loginCode" inputmode="numeric" maxlength="6" placeholder="请输入 6 位验证码" autocomplete="one-time-code">
        ${loginState.error ? `<div class="login-inline-error code-error">⚠ ${escapeHTML(loginState.error)}</div>` : ''}
        ${loginState.sentCode ? `<div class="demo-code">本地演示验证码：<b>${loginState.sentCode}</b></div>` : '<div class="demo-code sms-sent">验证码已发送，请查看手机短信</div>'}
        <button class="login-primary" data-login-action="verify-code">确认登录</button>
      </section>`;
  }
  if (loginState.stage === 'account' && state.user) {
    const orders = loadOrders().filter(order => order.userId === state.user.id).slice(-3).reverse();
    const entitlement = state.entitlement || { plan: 'none' };
    const memberName = entitlement.plan === 'basic' ? '向晴会员' : entitlement.plan === 'pro' ? '无限会员' : '暂未开通会员';
    overlay.innerHTML = `
      <section class="login-sheet account-sheet" role="dialog" aria-modal="true" aria-labelledby="accountTitle">
        <button class="payment-close" data-login-action="close" aria-label="关闭账号中心">×</button>
        <div class="account-avatar">${state.user.provider === 'phone' ? '晴' : state.user.provider === 'wechat' ? '微' : 'A'}</div>
        <h2 id="accountTitle">${escapeHTML(state.user.displayName || maskPhone(state.user.phone))}</h2>
        <p class="account-id">用户 ID：${escapeHTML(state.user.id)}</p>
        <div class="account-benefits"><div><span>今日剩余免费额度</span><strong>${state.user.freeCredits || 0}<i> 次</i></strong></div><div><span>当前会员</span><strong>${memberName}</strong></div></div>
        <div class="redeem-card"><div><b>闲鱼兑换码</b><small>已在闲鱼付款？把卖家发给你的兑换码填在这里。</small></div><div><input id="redeemCode" maxlength="20" placeholder="例如 XQ-ABCD-EFGH-JKLM"><button data-login-action="redeem">确认兑换</button></div><p id="redeemError"></p></div>
        <h3>最近订单</h3>
        <div class="order-list">${orders.length ? orders.map(order => `<div><span><b>${escapeHTML(order.orderNo)}</b><small>${order.planName} · ${order.methodName}</small></span><em>${order.status === 'FULFILLED' ? '已到账 / 已发放' : order.status}</em></div>`).join('') : '<p>还没有付费订单。每天前 3 次下载免费，不着急。</p>'}</div>
        <button class="account-logout" data-login-action="logout">退出当前账号</button>
      </section>`;
  }
  bindLoginActions();
}

function bindLoginActions() {
  const overlay = document.querySelector('#loginOverlay');
  if (!overlay) return;
  overlay.querySelectorAll('[data-login-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.loginAction;
    if (action === 'close') { pendingAfterLogin = null; overlay.remove(); }
    if (action === 'back') { loginState.stage = 'phone'; loginState.error = ''; renderLoginModal(); }
    if (action === 'send-code') {
      const phone = overlay.querySelector('#loginPhone')?.value.trim() || '';
      if (!/^1[3-9]\d{9}$/.test(phone)) {
        loginState.phone = phone;
        loginState.error = '调皮的小宝宝手机号交出来';
        renderLoginModal();
        return;
      }
      button.disabled = true;
      button.textContent = '正在发送…';
      try {
        const result = backendMode ? await apiRequest('/api/auth/sms/send', { method: 'POST', body: { phone } }) : { demo_code: '123456' };
        loginState = { stage: 'code', phone, sentCode: result.demo_code || '', error: '' };
      } catch (_) {
        loginState.phone = phone;
        loginState.error = '验证码发送失败，请稍后再试一下';
        renderLoginModal();
        return;
      }
      renderLoginModal();
    }
    if (action === 'verify-code') {
      const code = overlay.querySelector('#loginCode')?.value.trim() || '';
      if (!/^\d{6}$/.test(code)) {
        loginState.error = '请输入完整的 6 位验证码';
        renderLoginModal();
        return;
      }
      if (backendMode) {
        button.disabled = true;
        button.textContent = '正在登录…';
        try {
          const result = await apiRequest('/api/auth/sms/verify', { method: 'POST', body: { phone: loginState.phone, code } });
          authToken = result.token;
          localStorage.setItem('sunny-auth-token', authToken);
          await completeServerLogin(result.user);
        } catch (_) {
          loginState.error = '验证码不正确或已经过期';
          renderLoginModal();
        }
      } else {
        if (code !== loginState.sentCode) {
          loginState.error = '验证码不正确，请输入页面显示的测试验证码';
          renderLoginModal();
          return;
        }
        completeLogin({ id: `phone_${loginState.phone}`, phone: loginState.phone, provider: 'phone', displayName: maskPhone(loginState.phone) });
      }
    }
    if (action === 'logout') logoutUser();
    if (action === 'redeem') {
      const code = overlay.querySelector('#redeemCode')?.value.trim().toUpperCase() || '';
      const errorBox = overlay.querySelector('#redeemError');
      if (!backendMode) {
        errorBox.textContent = '兑换码需要通过完整服务器链接使用';
        return;
      }
      if (!/^XQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        errorBox.textContent = '兑换码格式不正确，请检查后再输入';
        return;
      }
      button.disabled = true;
      button.textContent = '兑换中…';
      try {
        const result = await apiRequest('/api/redemptions/redeem', { method: 'POST', body: { code } });
        await syncServerSession();
        renderLoginModal();
        showToast(result.already_redeemed ? '这个兑换码已绑定到你的账号' : `兑换成功：${result.grant_text}`);
      } catch (error) {
        button.disabled = false;
        button.textContent = '确认兑换';
        errorBox.textContent = error.status === 409 ? '这个兑换码已经被其他账号使用' : '兑换码无效，请联系闲鱼卖家核对';
      }
    }
  }));
  overlay.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', () => completeProviderLogin(button.dataset.provider)));
  overlay.addEventListener('click', event => { if (event.target === overlay) { pendingAfterLogin = null; overlay.remove(); } });
}

async function completeProviderLogin(provider) {
  if (!backendMode || !appConfig.auth?.[provider]) {
    return showToast(`${provider === 'wechat' ? '微信' : 'Apple'} 真实登录尚未配置，不能创建虚拟用户`);
  }
  location.href = `/api/auth/oauth/${provider}/start`;
}

async function completeServerLogin(user) {
  state.user = normalizeServerUser(user);
  await syncServerSession();
  document.querySelector('#loginOverlay')?.remove();
  showToast(`登录成功，今日免费额度剩余 ${state.user?.freeCredits ?? 0} 次`);
  if (pendingAfterLogin?.startsWith('download:')) {
    const format = pendingAfterLogin.split(':')[1] || 'word';
    pendingAfterLogin = null;
    setTimeout(() => requestDownload(format), 350);
  }
}

function completeLogin(identity) {
  const existing = (() => { try { return JSON.parse(localStorage.getItem(`sunny-user-${identity.id}`)); } catch (_) { return null; } })();
  state.user = existing ? refreshLocalDailyCredits(existing) : { ...identity, freeCredits: 3, freeCreditDate: chinaDateKey(), createdAt: Date.now() };
  saveCurrentUser();
  state.entitlement = loadEntitlement(state.user.id);
  updateAccountHeader();
  document.querySelector('#loginOverlay')?.remove();
  showToast(existing ? '欢迎回来，账号权益已同步' : '登录成功，已领取今日 3 次免费下载');
  if (pendingAfterLogin?.startsWith('download:')) {
    const format = pendingAfterLogin.split(':')[1] || 'word';
    pendingAfterLogin = null;
    setTimeout(() => requestDownload(format), 350);
  }
}

async function logoutUser() {
  if (backendMode && authToken) {
    try { await apiRequest('/api/auth/logout', { method: 'POST', body: {} }); } catch (_) {}
  }
  localStorage.removeItem('sunny-current-user');
  localStorage.removeItem('sunny-auth-token');
  authToken = '';
  state.user = null;
  state.entitlement = { plan: 'none', credits: 0 };
  document.querySelector('#loginOverlay')?.remove();
  updateAccountHeader();
  showToast('已退出账号');
}

function loadOrders() {
  if (backendMode) return cachedServerOrders;
  try { return JSON.parse(localStorage.getItem('sunny-payment-orders')) || []; }
  catch (_) { return []; }
}

function saveOrder(order) {
  if (backendMode) {
    const index = cachedServerOrders.findIndex(item => item.orderNo === order.orderNo);
    if (index >= 0) cachedServerOrders[index] = order;
    else cachedServerOrders.push(order);
    return;
  }
  const orders = loadOrders();
  const index = orders.findIndex(item => item.orderNo === order.orderNo);
  if (index >= 0) orders[index] = order;
  else orders.push(order);
  localStorage.setItem('sunny-payment-orders', JSON.stringify(orders));
}

function loadEntitlement(userId) {
  if (!userId) return { plan: 'none', credits: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(`sunny-resume-entitlement-${userId}`));
    if (!saved) return { plan: 'none', credits: 0 };
    if (['basic', 'pro'].includes(saved.plan) && saved.expiresAt < Date.now()) return { plan: 'none', credits: 0 };
    return saved;
  } catch (_) {
    return { plan: 'none', credits: 0 };
  }
}

function saveEntitlement() {
  if (!state.user) return;
  localStorage.setItem(`sunny-resume-entitlement-${state.user.id}`, JSON.stringify(state.entitlement));
}

function getDownloadAccess() {
  const access = state.entitlement || { plan: 'none', credits: 0 };
  if (access.plan === 'basic' && access.expiresAt > Date.now()) return { allowed: true, description: '向晴会员有效期内 · 每周 35 次优化额度' };
  if (access.plan === 'pro' && access.expiresAt > Date.now()) return { allowed: true, description: '无限会员有效期内 · 每天不限次数' };
  if (state.user?.freeCredits > 0) return { allowed: true, type: 'free', description: `今日免费额度剩余 ${state.user.freeCredits} 次` };
  if (access.credits > 0) return { allowed: true, description: `单次下载权益剩余 ${access.credits} 次` };
  return { allowed: false, description: '' };
}

async function requestDownload(format = 'word') {
  if (!state.user) {
    pendingAfterLogin = `download:${format}`;
    return openLoginModal();
  }
  if (!getDownloadAccess().allowed) return openPaywall(format);
  await performDownload(format);
}

function openPaywall(format = 'word') {
  paymentState = { plan: 'single', method: 'wechat', stage: 'choose', orderNo: '', qrCode: '', demo: !backendMode, downloadFormat: format };
  const overlay = document.createElement('div');
  overlay.className = 'payment-overlay';
  overlay.id = 'paymentOverlay';
  document.body.appendChild(overlay);
  renderPaymentModal();
}

function renderPaymentModal() {
  const overlay = document.querySelector('#paymentOverlay');
  if (!overlay) return;
  const plan = plans[paymentState.plan];
  const directPaymentEnabled = Boolean(appConfig.directPaymentEnabled);
  const xianyuUrl = appConfig.xianyuItemUrls?.[plan.id] || appConfig.xianyuItemUrl || '';
  if (paymentState.stage === 'choose') {
    overlay.innerHTML = `
      <section class="payment-sheet" role="dialog" aria-modal="true" aria-labelledby="paymentTitle">
        <button class="payment-close" data-pay-action="close" aria-label="关闭支付">×</button>
        <div class="payment-intro"><span class="eyebrow">最后一步</span><h2 id="paymentTitle">前面都免费，满意再下载</h2><p>你选择的是 ${paymentState.downloadFormat === 'pdf' ? 'PDF 投递版' : 'Word 可编辑版'}。简历预览、编辑、修改说明和前后对比均不收费。</p></div>
        <div class="plan-list">
          ${Object.values(plans).map(item => `
            <button class="price-plan ${paymentState.plan === item.id ? 'selected' : ''}" data-plan="${item.id}">
              ${item.id === 'basic' ? '<em>求职季推荐</em>' : ''}
              <span class="plan-check">${paymentState.plan === item.id ? '✓' : ''}</span>
              <span class="plan-name"><b>${item.name}</b><small>${item.note}</small></span>
              <span class="plan-price"><strong>¥${item.price}</strong><small>/ ${item.unit}</small></span>
            </button>`).join('')}
        </div>
        <div class="membership-compare">
          <span>权益</span><span>单次</span><span>19.8 会员</span><span>29.8 无限</span>
          <b>Word 下载</b><i>1 次</i><i>不限</i><i>不限</i>
          <b>每周优化</b><i>本份</i><i>35 次</i><i>无限次</i>
          <b>有效期</b><i>本次</i><i>30 天</i><i>30 天</i>
        </div>
        ${directPaymentEnabled ? `
          <h3 class="pay-section-title">选择支付方式</h3>
          <div class="pay-methods">
            <button class="pay-method ${paymentState.method === 'wechat' ? 'selected' : ''}" data-method="wechat"><span class="wechat-icon">微</span><b>微信支付</b><i>${paymentState.method === 'wechat' ? '✓' : ''}</i></button>
            <button class="pay-method ${paymentState.method === 'alipay' ? 'selected' : ''}" data-method="alipay"><span class="alipay-icon">支</span><b>支付宝</b><i>${paymentState.method === 'alipay' ? '✓' : ''}</i></button>
          </div>
          <div class="payment-total"><span>应付金额 <small>支付完成后立即解锁</small></span><strong>¥${plan.price}</strong></div>
          <button class="pay-confirm" data-pay-action="create">确认支付 ¥${plan.price}</button>
          <p class="payment-safe">支付信息由微信 / 支付宝安全处理　·　会员到期不自动续费</p>
        ` : `
          <div class="xianyu-entry xianyu-checkout"><div><b>通过闲鱼安全购买</b><small>付款后，卖家会在闲鱼聊天中发送一次性兑换码</small></div>${xianyuUrl ? `<a href="${escapeHTML(xianyuUrl)}" target="_blank" rel="noopener">去闲鱼购买 ¥${plan.price}</a>` : '<span>商品链接配置后即可购买</span>'}<button data-pay-action="redeem">已购买，输入兑换码</button></div>
          <p class="payment-safe">付款和订单留在闲鱼内完成　·　兑换权益绑定当前登录账号</p>
        `}
      </section>`;
  }
  if (paymentState.stage === 'qr') {
    const methodName = paymentState.method === 'wechat' ? '微信' : '支付宝';
    const qrMarkup = paymentState.qrCode
      ? `<div class="real-qr"><img src="${escapeHTML(paymentState.qrCode)}" alt="${methodName}支付二维码"></div>`
      : '<div class="demo-qr"><i></i><i></i><i></i><span>演示支付码<br>请勿扫码</span></div>';
    overlay.innerHTML = `
      <section class="payment-sheet qr-sheet" role="dialog" aria-modal="true" aria-label="扫码支付">
        <button class="payment-close" data-pay-action="close" aria-label="关闭支付">×</button>
        <button class="pay-back" data-pay-action="back">← 返回选择套餐</button>
        <span class="${paymentState.method === 'wechat' ? 'wechat-icon' : 'alipay-icon'} pay-logo">${paymentState.method === 'wechat' ? '微' : '支'}</span>
        <h2>请使用${methodName}扫码支付</h2>
        <div class="pay-amount">¥${plan.price}</div>
        ${qrMarkup}
        <p class="order-number">订单号：${paymentState.orderNo}</p>
        <div class="payment-waiting"><i></i> 正在等待支付结果…</div>
        <div class="demo-payment-note">${paymentState.demo ? '当前为联调演示，不会真实扣款；点击下方按钮模拟支付平台到账回调。' : '支付完成后系统会自动确认到账并把权益发放到当前登录账号，请勿重复付款。'}</div>
        ${paymentState.demo ? '<button class="pay-confirm demo-success" data-pay-action="simulate-success">模拟支付成功</button>' : ''}
      </section>`;
  }
  if (paymentState.stage === 'success') {
    const paidOrder = loadOrders().find(order => order.orderNo === paymentState.orderNo);
    overlay.innerHTML = `
      <section class="payment-sheet success-sheet" role="dialog" aria-modal="true" aria-label="支付成功">
        <div class="payment-success-mark">✓</div>
        <span class="eyebrow">Payment complete</span>
        <h2>支付成功，下载权益已解锁</h2>
        <p>${plan.name} · ¥${plan.price}${plan.id === 'single' ? ' · 可下载本份简历 1 次' : ' · 有效期 30 天'}</p>
        <div class="payment-receipt"><span>订单号</span><b>${paymentState.orderNo}</b><span>收款状态</span><b class="receipt-paid">✓ 已到账</b><span>发放权益</span><b>${escapeHTML(paidOrder?.grantText || plan.note)}</b></div>
        <button class="pay-confirm" data-pay-action="download-now">立即下载 ${paymentState.downloadFormat === 'pdf' ? 'PDF' : 'Word'} 简历 ↓</button>
        <small>文件将保存至浏览器默认下载位置</small>
      </section>`;
  }
  bindPaymentActions();
  if (paymentState.stage === 'qr' && backendMode) startOrderPolling();
}

function bindPaymentActions() {
  const overlay = document.querySelector('#paymentOverlay');
  if (!overlay) return;
  overlay.querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => {
    paymentState.plan = button.dataset.plan;
    renderPaymentModal();
  }));
  overlay.querySelectorAll('[data-method]').forEach(button => button.addEventListener('click', () => {
    paymentState.method = button.dataset.method;
    renderPaymentModal();
  }));
  overlay.querySelectorAll('[data-pay-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.payAction;
    if (action === 'close') { stopOrderPolling(); overlay.remove(); }
    if (action === 'back') { stopOrderPolling(); paymentState.stage = 'choose'; renderPaymentModal(); }
    if (action === 'redeem') {
      stopOrderPolling();
      overlay.remove();
      openLoginModal();
    }
    if (action === 'create') {
      const chosenPlan = plans[paymentState.plan];
      button.disabled = true;
      button.textContent = '正在创建订单…';
      if (backendMode) {
        try {
          const result = await apiRequest('/api/payments/orders', { method: 'POST', body: { plan: paymentState.plan, method: paymentState.method } });
          paymentState.orderNo = result.order_no;
          paymentState.qrCode = result.qr_image_url || '';
          paymentState.demo = Boolean(result.demo);
          saveOrder(normalizeServerOrder({ order_no: result.order_no, user_id: state.user.id, plan: paymentState.plan, method: paymentState.method, amount: result.amount, status: result.status }));
        } catch (_) {
          button.disabled = false;
          button.textContent = `确认支付 ¥${chosenPlan.price}`;
          return showToast('订单创建失败，请稍后重试');
        }
      } else {
        paymentState.orderNo = `XQ${Date.now().toString().slice(-10)}`;
        saveOrder({
          orderNo: paymentState.orderNo,
          userId: state.user.id,
          plan: chosenPlan.id,
          planName: chosenPlan.name,
          amount: chosenPlan.price,
          method: paymentState.method,
          methodName: paymentState.method === 'wechat' ? '微信支付' : '支付宝',
          status: 'PENDING',
          createdAt: Date.now()
        });
      }
      paymentState.stage = 'qr';
      renderPaymentModal();
    }
    if (action === 'simulate-success') await activatePlan();
    if (action === 'download-now') {
      overlay.remove();
      await performDownload(paymentState.downloadFormat);
    }
  }));
  overlay.addEventListener('click', event => { if (event.target === overlay) { stopOrderPolling(); overlay.remove(); } });
}

function stopOrderPolling() {
  if (paymentPollTimer) clearInterval(paymentPollTimer);
  paymentPollTimer = null;
}

function startOrderPolling() {
  stopOrderPolling();
  if (!paymentState.orderNo) return;
  let checks = 0;
  paymentPollTimer = setInterval(async () => {
    checks += 1;
    try {
      const data = await apiRequest(`/api/payments/orders/${encodeURIComponent(paymentState.orderNo)}`);
      const order = normalizeServerOrder(data.order);
      saveOrder(order);
      if (order.status === 'FULFILLED') {
        stopOrderPolling();
        await syncServerSession();
        paymentState.stage = 'success';
        renderPaymentModal();
      }
      if (['CLOSED', 'REFUNDED'].includes(order.status) || checks >= 60) {
        stopOrderPolling();
        if (checks >= 60) showToast('订单仍在确认中，可稍后在账号中心查看');
      }
    } catch (_) {
      if (checks >= 60) stopOrderPolling();
    }
  }, 2000);
}

async function activatePlan() {
  if (backendMode) {
    try {
      await apiRequest('/api/payments/demo-confirm', { method: 'POST', body: { order_no: paymentState.orderNo } });
      await syncServerSession();
      stopOrderPolling();
      paymentState.stage = 'success';
      return renderPaymentModal();
    } catch (_) {
      return showToast('到账确认失败，请检查订单状态');
    }
  }
  const plan = paymentState.plan;
  const order = loadOrders().find(item => item.orderNo === paymentState.orderNo);
  if (!order || order.userId !== state.user?.id) return showToast('订单与当前账号不匹配，请重新下单');
  if (order.status === 'FULFILLED') {
    paymentState.stage = 'success';
    return renderPaymentModal();
  }
  order.status = 'PAID';
  order.paidAt = Date.now();
  order.providerTransactionId = `DEMO_${Date.now()}`;
  if (plan === 'single') state.entitlement = { plan, credits: 1, purchasedAt: Date.now() };
  else state.entitlement = { plan, credits: 0, purchasedAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, usageDate: '', usageCount: 0 };
  saveEntitlement();
  order.status = 'FULFILLED';
  order.fulfilledAt = Date.now();
  order.grantText = plan === 'single' ? '单次简历下载额度 × 1' : plan === 'basic' ? '30 天会员 · 每周 35 次优化额度' : '30 天无限会员 · 不限次数';
  saveOrder(order);
  refreshDownloadUI();
  paymentState.stage = 'success';
  renderPaymentModal();
}

function refreshDownloadUI() {
  const access = getDownloadAccess();
  const note = document.querySelector('.download-dock-action > span');
  document.querySelectorAll('.download-primary').forEach(button => {
    const label = button.dataset.format === 'pdf' ? 'PDF' : 'Word';
    button.textContent = `下载 ${label}`;
  });
  if (note) note.textContent = access.allowed ? access.description : '选择需要的格式，生成后可直接使用';
}

async function performDownload(format = 'word') {
  if (backendMode) {
    try {
      await apiRequest('/api/quota/consume', { method: 'POST', body: { action: 'download' } });
      await syncServerSession();
    } catch (error) {
      if (error.status === 402) openPaywall(format);
      else showToast('下载权益校验失败，请稍后重试');
      return;
    }
  }
  const content = getCleanResumeHTML();
  if (format === 'pdf') exportPdf(content);
  else exportWord(content);

  if (!backendMode) consumeLocalDownloadCredit();
  refreshDownloadUI();
  updateAccountHeader();
}

function getCleanResumeHTML() {
  const cleanResume = document.querySelector('#resumePaper').cloneNode(true);
  cleanResume.querySelectorAll('.change-reason').forEach(note => note.remove());
  cleanResume.querySelectorAll('.page-break-label').forEach(label => label.remove());
  cleanResume.querySelectorAll('.change-rewrite, .change-added, .change-keyword').forEach(mark => mark.replaceWith(...mark.childNodes));
  return cleanResume.innerHTML;
}

function consumeLocalDownloadCredit() {
  const hasActiveMembership = ['basic', 'pro'].includes(state.entitlement.plan) && state.entitlement.expiresAt > Date.now();
  if (!hasActiveMembership && state.user?.freeCredits > 0) {
    state.user.freeCredits -= 1;
    saveCurrentUser();
    showToast(`已使用 1 次今日免费额度，还剩 ${state.user.freeCredits} 次`);
  } else if (state.entitlement.credits > 0) {
    state.entitlement.credits = Math.max(0, (state.entitlement.credits || 0) - 1);
    saveEntitlement();
  }
}

function exportWord(content) {
  const name = state.form.name || '我的';
  const filename = `${name}-${state.form.position || '求职'}-2页优化简历.doc`;
  const word = `<!doctype html><html><head><meta charset="UTF-8"><style>@page{size:A4;margin:1.7cm}body{font-family:'Microsoft YaHei',Arial,sans-serif;color:#18352e;line-height:1.62;margin:0}.resume-page{min-height:24.5cm;position:relative}.resume-page+.resume-page{page-break-before:always}h1{font-size:25px;letter-spacing:4px;margin:0 0 8px}h2{font-size:13px;border-left:4px solid #ef765f;padding-left:8px;margin:22px 0 11px;letter-spacing:1px}h3{font-size:12px;color:#275f50;margin:7px 0}p,li{font-size:11px;margin-top:3px}.resume-head{border-bottom:2px solid #18352e;padding-bottom:16px;display:flex;justify-content:space-between}.resume-contact{text-align:right;font-size:10px}.experience{margin-bottom:16px}.experience-title{display:flex;justify-content:space-between;font-size:11px}.competency-grid{display:table;width:100%;border-spacing:5px}.competency-grid span{display:table-cell;background:#f2f6f3;padding:7px;font-size:9px;text-align:center}.resume-page-title{border-bottom:2px solid #18352e;padding-bottom:14px;display:flex;justify-content:space-between}.skills-list p{margin:5px 0}.page-number{position:absolute;right:0;bottom:0;font-size:9px;color:#999}</style></head><body>${content}</body></html>`;
  const blob = new Blob(['\ufeff', word], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  const status = document.querySelector('#downloadStatus');
  if (status) {
    status.innerHTML = `<span>✓ 已生成并开始下载：<b>${escapeHTML(filename)}</b></span><span>请查看浏览器下载记录或系统“下载”文件夹</span>`;
    status.classList.add('show');
    status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  showToast('已开始下载 2 页 Word 简历');
}

function exportPdf(content) {
  const name = state.form.name || '我的';
  const filename = `${name}-${state.form.position || '求职'}-2页优化简历.pdf`;
  const frame = document.createElement('iframe');
  frame.className = 'pdf-print-frame';
  frame.setAttribute('title', 'PDF 导出窗口');
  frame.srcdoc = `<!doctype html><html><head><meta charset="UTF-8"><title>${escapeHTML(filename)}</title><style>@page{size:A4;margin:1.7cm}*{box-sizing:border-box}body{font-family:'Microsoft YaHei',Arial,sans-serif;color:#18352e;line-height:1.62;margin:0}.resume-page{min-height:24.5cm;position:relative;page-break-after:always}.resume-page:last-child{page-break-after:auto}h1{font-size:25px;letter-spacing:4px;margin:0 0 8px}h2{font-size:13px;border-left:4px solid #ef765f;padding-left:8px;margin:22px 0 11px;letter-spacing:1px}h3{font-size:12px;color:#275f50;margin:7px 0}p,li{font-size:11px;margin-top:3px}.resume-head{border-bottom:2px solid #18352e;padding-bottom:16px;display:flex;justify-content:space-between}.resume-contact{text-align:right;font-size:10px}.experience{margin-bottom:16px}.experience-title,.resume-page-title{display:flex;justify-content:space-between}.competency-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.competency-grid span{background:#f2f6f3;padding:7px;font-size:9px;text-align:center}.skills-list p{margin:5px 0}.page-number{position:absolute;right:0;bottom:0;font-size:9px;color:#999}</style></head><body>${content}</body></html>`;
  frame.addEventListener('load', () => {
    setTimeout(() => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        showDownloadStatus(`PDF 保存窗口已打开：${filename}`, '请在打印窗口选择“存储为 PDF”');
      } catch (_) {
        showToast('PDF 保存窗口打开失败，请重试');
      }
    }, 250);
  });
  document.body.appendChild(frame);
  setTimeout(() => frame.remove(), 60000);
}

function showDownloadStatus(primary, secondary) {
  const status = document.querySelector('#downloadStatus');
  if (!status) return;
  status.innerHTML = `<span>✓ <b>${escapeHTML(primary)}</b></span><span>${escapeHTML(secondary)}</span>`;
  status.classList.add('show');
  status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'home') renderLanding();
  if (action === 'account') openLoginModal();
  if (action === 'help') { helpDialog.classList.add('open'); helpDialog.setAttribute('aria-hidden', 'false'); }
  if (action === 'close-help' || (event.target === helpDialog)) { helpDialog.classList.remove('open'); helpDialog.setAttribute('aria-hidden', 'true'); }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    helpDialog.classList.remove('open');
    helpDialog.setAttribute('aria-hidden', 'true');
    document.querySelector('#paymentOverlay')?.remove();
    document.querySelector('#loginOverlay')?.remove();
  }
});

loadDraft();
renderLanding();
updateAccountHeader();
if (backendMode && authToken) syncServerSession();
