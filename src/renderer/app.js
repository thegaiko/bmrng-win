'use strict';
const $ = (id) => document.getElementById(id);
const api = window.bmrng;

let catalog = [];
let selected = new Set();
let user = null;
let rows = new Map();       // key -> {el, bar, state, img, nm}
let awaitingCode = false;

// ------------------------------------------------------------ загрузка ----
async function init() {
  wireAuth();
  wireMain();
  wireTopup();
  api.flow.on(onFlow);
  api.update.on(onUpdate);
  const has = await api.backend.hasToken();
  if (has.ok && has.data) {
    const me = await api.backend.me();
    if (me.ok) return enterMain(me.data);
  }
  showAuth();
}

function showAuth() { $('auth').style.display = 'flex'; $('main').style.display = 'none'; }
async function enterMain(u) {
  user = u;
  $('auth').style.display = 'none';
  $('main').style.display = 'flex';
  renderBalance();
  $('avatar').textContent = (u.name || u.email || '?').trim()[0].toUpperCase();
  $('acct-email').textContent = u.email || '';
  $('tu-price').textContent = u.price_per_install;
  await loadCatalog();
  checkDevice();
}

function renderBalance() {
  $('bal-n').textContent = user.install_balance;
  $('bal-word').textContent = installWord(user.install_balance);
}
function installWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'установок';
  if (b > 1 && b < 5) return 'установки';
  if (b === 1) return 'установка';
  return 'установок';
}

// ------------------------------------------------------------ авторизация ----
function wireAuth() {
  const show = (id) => ['form-login', 'form-register', 'form-verify', 'form-reset']
    .forEach((f) => $(f).classList.toggle('hidden', f !== id));
  const err = (m) => { $('auth-error').textContent = m || ''; };

  $('tab-login').onclick = () => { $('tab-login').classList.add('active'); $('tab-register').classList.remove('active'); show('form-login'); err(); };
  $('tab-register').onclick = () => { $('tab-register').classList.add('active'); $('tab-login').classList.remove('active'); show('form-register'); err(); };
  $('go-reset').onclick = () => { show('form-reset'); err(); };
  $('rs-back').onclick = () => { show('form-login'); err(); };

  $('form-login').onsubmit = async (e) => {
    e.preventDefault(); err('');
    const r = await api.backend.login($('li-email').value.trim(), $('li-pass').value);
    if (!r.ok) return err(r.error);
    enterMain(r.data);
  };

  let pendingEmail = '';
  $('form-register').onsubmit = async (e) => {
    e.preventDefault(); err('');
    const r = await api.backend.register($('rg-name').value.trim(), $('rg-email').value.trim(), $('rg-pass').value);
    if (!r.ok) return err(r.error);
    pendingEmail = $('rg-email').value.trim();
    $('vf-email').textContent = pendingEmail;
    show('form-verify');
  };
  $('vf-resend').onclick = async () => { await api.backend.resend(pendingEmail); err('Код отправлен снова'); };
  $('form-verify').onsubmit = async (e) => {
    e.preventDefault(); err('');
    const r = await api.backend.verify(pendingEmail, $('vf-code').value.trim());
    if (!r.ok) return err(r.error);
    enterMain(r.data);
  };

  let resetSent = false;
  $('form-reset').onsubmit = async (e) => {
    e.preventDefault(); err('');
    const email = $('rs-email').value.trim();
    if (!resetSent) {
      const r = await api.backend.resetRequest(email);
      if (!r.ok) return err(r.error);
      resetSent = true; $('rs-step2').classList.remove('hidden'); $('rs-btn').textContent = 'Сменить пароль';
      err('Код отправлен на почту');
    } else {
      const r = await api.backend.resetConfirm(email, $('rs-code').value.trim(), $('rs-pass').value);
      if (!r.ok) return err(r.error);
      err('Пароль изменён — войдите'); resetSent = false; $('rs-step2').classList.add('hidden'); $('rs-btn').textContent = 'Отправить код';
      show('form-login');
    }
  };
}

// ------------------------------------------------------------ главный экран ----
function wireMain() {
  const menu = $('account-menu');
  $('avatar').onclick = () => menu.classList.toggle('hidden');
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== $('avatar')) menu.classList.add('hidden');
  });
  $('mi-logout').onclick = async () => { await api.backend.logout(); menu.classList.add('hidden'); location.reload(); };
  $('mi-downloads').onclick = () => api.app.openDownloads();
  $('mi-refresh').onclick = async () => { const r = await api.backend.me(); if (r.ok) { user = r.data; renderBalance(); } };
  $('search').oninput = () => renderCatalog($('search').value.trim().toLowerCase());
  $('btn-go').onclick = onGo;
  $('update-install').onclick = () => api.update.install();
}

async function loadCatalog() {
  const r = await api.backend.catalog();
  catalog = r.ok && Array.isArray(r.data) ? r.data : [];
  renderCatalog('');
}
function renderCatalog(filter) {
  const grid = $('apps-grid');
  grid.innerHTML = '';
  for (const item of catalog) {
    if (filter && !item.name.toLowerCase().includes(filter)) continue;
    const el = document.createElement('div');
    el.className = 'app-item' + (selected.has(item.key) ? ' sel' : '');
    el.innerHTML = `<img src="${item.icon || ''}" alt="" />
      <div class="nm">${escapeHtml(item.name)}</div><div class="spacer"></div>
      <div class="check">${selected.has(item.key) ? '✓' : ''}</div>`;
    el.onclick = () => { selected.has(item.key) ? selected.delete(item.key) : selected.add(item.key); renderCatalog(filter); };
    grid.appendChild(el);
  }
}

async function checkDevice() {
  const chip = $('device-chip');
  const r = await api.devices.check();
  if (!r.ok) { chip.textContent = 'iPhone: —'; return; }
  const d = r.data;
  if (!d.tools) { chip.textContent = 'iPhone: нет ideviceinstaller'; chip.className = 'device-chip'; }
  else if (d.udid) { chip.textContent = 'iPhone: ' + (d.name || 'подключён'); chip.className = 'device-chip on'; }
  else { chip.textContent = 'iPhone: не подключён'; chip.className = 'device-chip'; }
}

// собрать выбранные приложения + ручные ID
function collectApps() {
  const apps = [];
  for (const item of catalog) {
    if (!selected.has(item.key)) continue;
    const id = (item.app_ids && item.app_ids[0]) ? String(item.app_ids[0]) : item.bundle_id;
    apps.push({ key: item.key, name: item.name, id, icon: item.icon });
  }
  const manual = $('manual-ids').value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  manual.forEach((raw, i) => apps.push({ key: 'manual-' + i + '-' + raw, name: raw, id: raw, icon: '' }));
  return apps;
}

async function onGo() {
  const err = (m) => { $('flow-error').textContent = m || ''; };
  err('');

  if (awaitingCode) {
    const code = $('ap-code').value.trim();
    if (!code) return err('Введите код из сообщения Apple');
    lock(true); $('flow-status').textContent = 'Проверяю код…';
    const r = await api.flow.code(code);
    return handleLogin(r);
  }

  const apps = collectApps();
  const email = $('ap-email').value.trim();
  const pass = $('ap-pass').value;
  if (!apps.length) return err('Шаг 1: выберите хотя бы одно приложение');
  if (!email || !pass) return err('Шаг 2: введите Apple ID и пароль');

  rows.clear(); $('progress-list').innerHTML = '';
  apps.forEach((a) => addRow(a));
  lock(true);
  $('flow-status').textContent = 'Занимаю свободный мак и вхожу в Apple ID…';
  const r = await api.flow.login(apps, email, pass);
  handleLogin(r);
}

function handleLogin(r) {
  const err = (m) => { $('flow-error').textContent = m || ''; };
  if (!r.ok) { lock(false); return err(r.error); }
  const res = r.data;
  if (res.status === '2fa') {
    awaitingCode = true; lock(false);
    $('code-row').classList.remove('hidden');
    $('btn-go').textContent = 'Подтвердить код';
    $('ap-code').focus();
    $('flow-status').textContent = 'Нужен код двухфакторной аутентификации';
    return;
  }
  if (res.status === 'error') { lock(false); resetGo(); return err(res.message); }
  // ok — дальше пойдут события flow
  awaitingCode = false; resetGo();
  $('flow-status').textContent = 'Вошли. Запрашиваю ссылки…';
}

function resetGo() { $('code-row').classList.add('hidden'); $('btn-go').textContent = 'Войти и скачать'; $('ap-code').value = ''; }
function lock(on) {
  ['ap-email', 'ap-pass', 'manual-ids', 'search'].forEach((i) => $(i).disabled = on);
  $('btn-go').disabled = on;
}

// прогресс-строка
function addRow(app) {
  const el = document.createElement('div');
  el.className = 'progress-row';
  el.innerHTML = `<img src="${app.icon || ''}" alt="" /><div class="nm">${escapeHtml(app.name)}</div>
    <div class="bar"><i></i></div><div class="state">ожидает</div>`;
  $('progress-list').appendChild(el);
  rows.set(app.key, { el, bar: el.querySelector('i'), state: el.querySelector('.state'), nm: el.querySelector('.nm') });
}
function setRow(key, { pct, state, name } = {}) {
  const r = rows.get(key); if (!r) return;
  if (pct != null) r.bar.style.width = pct + '%';
  if (state != null) r.state.textContent = state;
  if (name) r.nm.textContent = name;
}

// ------------------------------------------------------------ события flow ----
function onFlow({ event, payload }) {
  if (event === 'phase') return onPhase(payload);
  if (event === 'balance') { if (user) { user.install_balance = payload.balance; renderBalance(); } return; }
  if (event === 'app') return onApp(payload);
  if (event === 'done') return onDone(payload);
}

function onPhase(p) {
  const q = $('queue-banner');
  if (p.phase === 'queue') {
    q.classList.remove('hidden');
    q.textContent = p.position > 1 ? `Все маки заняты. Вы ${p.position}-й в очереди — ждём…` : 'Все маки заняты. Вы следующий — ждём освобождения…';
    return;
  }
  q.classList.add('hidden');
  const map = {
    'no-macs': 'Маки сейчас не подключены — встаём в очередь…',
    connecting: 'Подключаюсь к серверу…',
    login: 'Вхожу в Apple ID…',
    'logged-in': 'Вошли: ' + (p.name || '') + '. Запрашиваю ссылки…',
    links: 'Получаю ссылки на приложения…',
    released: 'Мак свободен. Качаю напрямую с Apple…',
  };
  if (map[p.phase]) $('flow-status').textContent = map[p.phase];
}

function onApp(p) {
  const labels = {
    meta: () => setRow(p.key, { state: 'в очереди', name: p.name ? `${p.name} ${p.version || ''}` : undefined }),
    downloading: () => setRow(p.key, { pct: p.pct, state: `качаю ${p.pct || 0}%` }),
    building: () => setRow(p.key, { pct: 100, state: 'собираю…' }),
    installing: () => setRow(p.key, { state: 'ставлю на iPhone…' }),
    installed: () => setRow(p.key, { state: '✓ установлено' }),
    ready: () => setRow(p.key, { state: p.message ? '⚠ ' + p.message : 'готово (файл)' }),
    error: () => setRow(p.key, { state: '⚠ ' + (p.message || 'ошибка') }),
  };
  (labels[p.state] || (() => {}))();
}

function onDone(p) {
  lock(false); resetGo(); awaitingCode = false;
  if (p.error) { $('flow-status').textContent = 'Ошибка: ' + p.error; return; }
  if (p.balance != null && user) { user.install_balance = p.balance; renderBalance(); }
  $('flow-status').textContent = p.installed
    ? `Готово: установлено ${p.installed} из ${p.total}.`
    : 'Скачивание завершено. Проверьте состояние приложений.';
}

// ------------------------------------------------------------ пополнение ----
function wireTopup() {
  let qty = 10;
  const total = () => { $('tu-total').textContent = user ? '· ' + (qty * user.price_per_install) + ' ₽' : ''; };
  $('btn-topup').onclick = () => { $('topup-overlay').classList.remove('hidden'); total(); };
  $('tu-cancel').onclick = () => $('topup-overlay').classList.add('hidden');
  $('tu-qty').querySelectorAll('button').forEach((b) => b.onclick = () => {
    $('tu-qty').querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel'); qty = parseInt(b.dataset.q, 10); total();
  });
  $('tu-pay').onclick = async () => {
    $('tu-error').textContent = '';
    const r = await api.backend.topup(qty, $('tu-code').value.trim());
    if (!r.ok) return $('tu-error').textContent = r.error;
    const d = r.data;
    if (d.confirmation_url) { api.app.openExternal(d.confirmation_url); $('tu-error').textContent = 'Оплата открыта в браузере. Баланс обновится после оплаты.'; }
    else if (d.balance != null && user) { user.install_balance = d.balance; renderBalance(); $('topup-overlay').classList.add('hidden'); }
  };
}

// ------------------------------------------------------------ обновления ----
function onUpdate(m) {
  const b = $('update-banner');
  if (m.state === 'available') { b.classList.remove('hidden'); $('update-text').textContent = `Загружаю обновление ${m.version}…`; $('update-install').classList.add('hidden'); }
  else if (m.state === 'downloading') { b.classList.remove('hidden'); $('update-text').textContent = `Загружаю обновление… ${m.percent}%`; }
  else if (m.state === 'ready') { b.classList.remove('hidden'); $('update-text').textContent = `Обновление ${m.version} готово.`; $('update-install').classList.remove('hidden'); }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

init();
