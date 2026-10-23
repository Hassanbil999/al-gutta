import { t, CURRENCIES } from './i18n.js';
import { api, isCloud } from './store.js';
import { qamariya, moodOf } from './qamariya.js';

// ---------- small utils ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const ICON = {
  back: '<svg viewBox="0 0 24 24" class="flip"><path d="M15 5l-7 7 7 7"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><rect class="knob" x="14" y="4.5" width="4" height="5" rx="2"/><rect class="knob" x="8" y="14.5" width="4" height="5" rx="2"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
  wa: '<svg viewBox="0 0 24 24"><path d="M4 20l1.3-4A8 8 0 1112 20a8 8 0 01-3.9-1z"/><path d="M9 9.5c.3 2.3 2.2 4.3 4.5 4.8l1.2-1.2 1.8.8c-.2 1-1 1.6-2 1.6A6 6 0 017.5 9.5c0-1 .6-1.8 1.6-2l.8 1.8z" class="fill"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};

// ---------- state ----------
const browserAr = (navigator.language || '').toLowerCase().startsWith('ar');
const settings = Object.assign({ lang: browserAr ? 'ar' : 'en', nums: null, name: '' }, LS.get('qy.settings', {}));
const saveSettings = () => LS.set('qy.settings', settings);
let tabs = LS.get('qy.tabs', []);
const saveTabs = () => LS.set('qy.tabs', tabs);
let current = null;            // { token, data, offline, missing }
let pollTimer = null;
let installPrompt = null;

const T = (k, ...a) => t(settings.lang, k, ...a);
const nums = () => settings.nums || (settings.lang === 'ar' ? 'arab' : 'latn');
const nf = () => new Intl.NumberFormat(nums() === 'arab' ? 'ar-u-nu-arab' : 'en-US', { maximumFractionDigits: 2 });
const curLabel = (c) => (CURRENCIES[c] || { ar: c, en: c })[settings.lang];
const money = (n, cur) => `<bdi class="money"><span class="n">${nf().format(Math.abs(n))}</span><span class="cur">${esc(curLabel(cur))}</span></bdi>`;
const when = (iso) => {
  const loc = (settings.lang === 'ar' ? 'ar' : 'en-GB') + '-u-nu-' + nums();
  try { return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleString(); }
};
const statusOf = (bal, name) => (moodOf(bal) === 'even' ? T('even') : bal > 0 ? T('owesYou', esc(name)) : T('youOwe', esc(name)));
// balances per currency: { YER: 3000, USD: -20 }; older cached tabs only had one balance
const balsOf = (x) => x?.balances ?? (x?.balance ? { [x.currency]: x.balance } : {});
const balList = (b, first) => Object.entries(b).filter(([, v]) => Math.abs(v) >= 0.005)
  .sort(([a], [c]) => (a === first ? -1 : c === first ? 1 : a.localeCompare(c)));
const moodOfB = (b) => {
  const v = Object.values(b).filter((n) => Math.abs(n) >= 0.005);
  if (!v.length) return 'even';
  return v.every((n) => n > 0) ? 'plus' : v.every((n) => n < 0) ? 'minus' : 'mixed';
};
const statusOfB = (b, name) => {
  const m = moodOfB(b);
  return m === 'mixed' ? T('mixed') : m === 'even' ? T('even') : m === 'plus' ? T('owesYou', esc(name)) : T('youOwe', esc(name));
};
const signed = (v, c) => `<span class="${v > 0 ? 'pos' : 'neg'}">${money(v, c)}</span>`;
const linkFor = (tok) => location.origin + location.pathname.replace(/index\.html$/, '') + '#/t/' + tok;
const parseAmount = (s) => {
  s = String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٬,\s]/g, '').replace(/[٫]/g, '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

function upsertTab(token, d) {
  let x = tabs.find((x) => x.token === token);
  if (!x) { x = { token }; tabs.unshift(x); }
  Object.assign(x, {
    friend: d.friend, me: d.me, currency: d.currency, balance: d.balance, balances: d.balances, side: d.side,
    ledgerId: d.ledger_id, updatedAt: d.updated_at, shareToken: d.share_token ?? x.shareToken,
  });
  saveTabs();
  return x;
}

// ---------- shell ----------
const app = $('#app');
function applyLang() {
  document.documentElement.lang = settings.lang;
  document.documentElement.dir = settings.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = T('appName');
}
function header({ title, back = false, actions = '' }) {
  return `<header class="top">
    <div class="bar">
      ${back ? `<button class="icon-btn" data-act="home" aria-label="${T('backHome')}">${ICON.back}</button>`
             : `<span class="brand-mark" aria-hidden="true">${qamariya({ variant: 'mini' })}</span>`}
      <h1 class="${back ? 'title' : 'brand'}">${title}</h1>
      <div class="bar-end">${actions}</div>
    </div>
    <div class="frieze" aria-hidden="true"></div>
  </header>`;
}
const demoBanner = () => (isCloud ? '' : `<p class="banner">${T('demo')}</p>`);

// ---------- views ----------
function renderOnboard() {
  app.innerHTML = `
  <main class="onboard">
    <button class="lang-pill" data-act="lang">${settings.lang === 'ar' ? 'English' : 'العربية'}</button>
    <div class="hero">${qamariya({ mood: 'even', variant: 'full' })}</div>
    <h1 class="hero-title">القطة ياعبدو</h1>
    <p class="hero-sub en-name">Al-Gutta Ya Abdo</p>
    <p class="tagline">${T('tagline')}</p>
    <form class="stack" data-form="start">
      <label class="field"><span>${T('yourName')}</span>
        <input name="name" maxlength="40" required autocomplete="given-name" placeholder="${T('namePh')}"></label>
      <button class="btn primary big" type="submit">${T('start')}</button>
    </form>
  </main>`;
}

function renderHome() {
  stopPoll();
  current = null;
  if (!settings.name && !tabs.length) return renderOnboard();
  const totals = {};
  for (const x of tabs) {
    for (const [cur, v] of Object.entries(balsOf(x))) {
      const c = (totals[cur] ??= { plus: 0, minus: 0 });
      if (v > 0) c.plus += v; else c.minus -= v;
    }
  }
  const curs = Object.keys(totals);
  const totalLines = (k) => curs.filter((c) => totals[c][k] > 0.004).map((c) => `<div>${money(totals[c][k], c)}</div>`).join('') || `<div class="zero">${money(0, curs[0] || tabs[0]?.currency || 'YER')}</div>`;
  app.innerHTML = `
  ${header({ title: T('appName'), actions: `<button class="icon-btn" data-act="settings" aria-label="${T('settings')}">${ICON.gear}</button>` })}
  ${demoBanner()}
  <main class="home">
    ${tabs.length ? `
      <section class="summary">
        <div class="sum plus"><small>${T('owedToYou')}</small>${totalLines('plus')}</div>
        <div class="sum minus"><small>${T('youOweTotal')}</small>${totalLines('minus')}</div>
      </section>
      <ul class="tabs">${tabs.map(tabRow).join('')}</ul>`
    : `<div class="empty-home">${qamariya({ mood: 'even', variant: 'mini' })}<p>${esc(T('homeEmpty')).replace('\n', '<br>')}</p></div>`}
  </main>
  <button class="fab" data-act="new"><span>+</span> ${T('addFriend')}</button>`;
}

function tabRow(x) {
  const b = balsOf(x), mood = moodOfB(b);
  return `<li><button class="tab-row mood-${mood}" data-act="open" data-token="${esc(x.token)}">
    <span class="mini">${qamariya({ mood, variant: 'mini' })}</span>
    <span class="who"><b>${esc(x.friend)}</b><small>${statusOfB(b, x.friend)}</small></span>
    <span class="amt">${balList(b, x.currency).map(([c, v]) => signed(v, c)).join('')}</span>
  </button></li>`;
}

function renderCounter() {
  const c = current;
  if (!c) return;
  const d = c.data;
  if (!d) {
    app.innerHTML = `${header({ title: '', back: true })}
      <main class="counter loading">${c.missing
        ? `<div class="empty-home">${qamariya({ mood: 'minus', variant: 'mini' })}<p>${T('notFound')}</p><button class="btn" data-act="home">${T('backHome')}</button></div>`
        : `<div class="window skeleton">${qamariya({ mood: 'even', variant: 'full' })}</div>`}</main>`;
    return;
  }
  const bals = balsOf(d), list = balList(bals, d.currency), mood = moodOfB(bals);
  const canShare = d.side === 'a' && d.share_token;
  app.innerHTML = `
  ${header({ title: esc(d.friend), back: true, actions: `
      ${canShare ? `<button class="icon-btn" data-act="share" aria-label="${T('share')}">${ICON.share}</button>` : ''}
      <button class="icon-btn" data-act="menu" aria-label="${T('settings')}">${ICON.more}</button>` })}
  ${demoBanner()}
  ${c.offline ? `<p class="banner warn">${T('offline')}</p>` : ''}
  <main class="counter mood-${mood}">
    <div class="window">${qamariya({ mood, variant: 'full', label: statusOfB(bals, d.friend) })}</div>
    <div class="balance">${list.length > 1
      ? `<div class="multi">${list.map(([c, v]) => `<div class="bal-line ${v > 0 ? 'pos' : 'neg'}">
           <span class="amount">${money(v, c)}</span><small>${statusOf(v, d.friend)}</small></div>`).join('')}</div>`
      : `<div class="amount">${mood === 'even' ? `<bdi class="money"><span class="n">${settings.lang === 'ar' && nums() === 'arab' ? 'صفر' : nf().format(0)}</span></bdi>` : money(list[0][1], list[0][0])}</div>
         <div class="status">${statusOfB(bals, d.friend)}</div>`}
    </div>
    <div class="actions">
      <button class="act plus" data-act="add" data-dir="1"><span class="big">${T('plus')}</span><small>${T('plusSub')}</small></button>
      <button class="act minus" data-act="add" data-dir="-1"><span class="big">${T('minus')}</span><small>${T('minusSub')}</small></button>
    </div>
    <div class="row2">
      ${mood !== 'even' ? `<button class="btn ghost" data-act="settle">✦ ${T('settle')}</button>` : ''}
      ${canShare ? `<button class="btn ghost" data-act="share">${ICON.share} ${T('share')}</button>` : ''}
    </div>
    <section class="history">
      <h2>${T('history')}</h2>
      ${d.entries.length ? `<ol>${d.entries.map((e) => entryRow(e, d)).join('')}</ol>`
                         : `<p class="muted center">${esc(T('empty')).replace('\n', '<br>')}</p>`}
    </section>
  </main>`;
}

function entryRow(e, d) {
  const who = e.mine ? T('you') : esc(d.friend);
  if (e.kind === 'settle') {
    return `<li class="entry settle">
      <span class="sign">✦</span>
      <span class="meta"><b>${T('settled')}</b><small><bdi>${who}</bdi> · <bdi>${when(e.created_at)}</bdi></small></span>
      <span class="amt">${money(e.amount, e.currency || d.currency)}</span>
      <span class="ops">${e.mine ? `<button class="link" data-act="undo" data-id="${e.id}">${T('undo')}</button>` : ''}</span>
    </li>`;
  }
  const pos = e.amount > 0;
  return `<li class="entry ${pos ? 'pos' : 'neg'} ${e.disputed ? 'disputed' : ''}">
    <span class="sign">${pos ? '+' : '−'}</span>
    <span class="meta"><b>${esc(e.note) || (pos ? T('lentPos') : T('lentNeg'))}</b>
      <small><bdi>${who}</bdi> · <bdi>${when(e.created_at)}</bdi>${e.disputed ? ` · <em>${T('disputed')}</em>` : ''}</small>
      ${e.disputed && e.dispute_reason ? `<span class="reason">«<bdi>${esc(e.dispute_reason)}</bdi>»</span>` : ''}</span>
    <span class="amt">${money(e.amount, e.currency || d.currency)}</span>
    <span class="ops">${e.mine
      ? `<button class="link" data-act="undo" data-id="${e.id}">${T('undo')}</button>`
      : `<button class="link" data-act="dispute" data-id="${e.id}" data-disputed="${e.disputed ? 1 : 0}">${e.disputed ? T('undispute') : T('dispute')}</button>`}</span>
  </li>`;
}

// ---------- counter data ----------
async function openCounter(token) {
  current = { token, data: LS.get('qy.snap.' + token, null) };
  renderCounter();
  const first = !tabs.some((x) => x.token === token);
  await refresh({ first });
  startPoll();
}

async function refresh({ first = false } = {}) {
  const c = current;
  if (!c) return;
  try {
    const d = await api.get(c.token);
    if (current !== c) return;
    if (!d) { c.missing = true; c.data = null; renderCounter(); return; }
    // opened the link I sent to my friend? go to my own side instead
    const mine = tabs.find((x) => x.ledgerId === d.ledger_id && x.token !== c.token);
    if (mine && d.side === 'b' && mine.side === 'a') {
      toast(T('ownLink'));
      location.replace('#/t/' + mine.token);
      return;
    }
    const changed = JSON.stringify(d) !== JSON.stringify(c.data) || c.offline;
    c.data = d; c.offline = false; c.missing = false;
    LS.set('qy.snap.' + c.token, d);
    upsertTab(c.token, d);
    if (!settings.name) { settings.name = d.me; saveSettings(); }
    if (changed) renderCounter();
    if (first && d.side === 'b') welcomeSheet(d);
  } catch (e) {
    if (current !== c) return;
    if (!c.offline) { c.offline = true; renderCounter(); }
  }
}

function setData(d) {
  if (!current || !d) return;
  current.data = d;
  LS.set('qy.snap.' + current.token, d);
  upsertTab(current.token, d);
  renderCounter();
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => { if (!document.hidden && !$('#sheet-root').classList.contains('open')) refresh(); }, isCloud ? 6000 : 3000);
}
function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function refreshHome() {
  if (!tabs.length) return;
  try {
    const list = await api.summaries(tabs.map((x) => x.token));
    let changed = false;
    for (const s of list || []) {
      const x = tabs.find((x) => x.token === s.token);
      if (x && (JSON.stringify(x.balances) !== JSON.stringify(s.balances) || x.friend !== s.friend || x.updatedAt !== s.updated_at)) {
        Object.assign(x, { balances: s.balances, friend: s.friend, me: s.me, currency: s.currency, updatedAt: s.updated_at, ledgerId: s.ledger_id, side: s.side });
        changed = true;
      }
    }
    tabs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    saveTabs();
    if (changed && !current) renderHome();
  } catch {}
}

// ---------- sheets ----------
const sheetRoot = $('#sheet-root');
let sheetClose = null;
function sheet(html, onMount) {
  closeSheet(true);
  sheetRoot.innerHTML = `<div class="backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="grip"></div>${html}</div>`;
  requestAnimationFrame(() => sheetRoot.classList.add('open'));
  const prevFocus = document.activeElement;
  sheetClose = () => { sheetRoot.classList.remove('open'); setTimeout(() => { if (!sheetRoot.classList.contains('open')) sheetRoot.innerHTML = ''; }, 260); prevFocus?.focus?.(); };
  onMount?.($('.sheet', sheetRoot));
  setTimeout(() => $('.sheet [autofocus]', sheetRoot)?.focus(), 280);
}
function closeSheet(immediate) {
  if (!sheetClose) return;
  const f = sheetClose; sheetClose = null;
  if (immediate) { sheetRoot.classList.remove('open'); sheetRoot.innerHTML = ''; } else f();
}
sheetRoot.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

const currencyChips = (sel) => Object.keys(CURRENCIES).map((c) =>
  `<label class="chip"><input type="radio" name="currency" value="${c}" ${c === sel ? 'checked' : ''}><span>${CURRENCIES[c][settings.lang]}</span></label>`).join('');

function newTabSheet() {
  sheet(`<form class="stack" data-form="new">
    <h2 class="sheet-title">${T('addFriend')}</h2>
    ${settings.name ? '' : `<label class="field"><span>${T('yourName')}</span><input name="me" maxlength="40" required></label>`}
    <label class="field"><span>${T('friendName')}</span><input name="friend" maxlength="40" required autofocus placeholder="${T('friendPh')}"></label>
    <div class="field"><span>${T('currency')}</span><div class="chips">${currencyChips(tabs[0]?.currency || 'YER')}</div></div>
    <button class="btn primary big" type="submit">${T('create')}</button>
  </form>`);
}

function entrySheet(dir) {
  const d = current?.data;
  if (!d) return;
  sheet(`<form class="stack entry-form ${dir > 0 ? 'plus' : 'minus'}" data-form="entry" data-dir="${dir}">
    <h2 class="sheet-title">${dir > 0 ? T('owesYou', esc(d.friend)) : T('youOwe', esc(d.friend))}</h2>
    <label class="amount-field"><span class="sr">${T('amount')}</span>
      <input name="amount" inputmode="decimal" autocomplete="off" required autofocus placeholder="${nf().format(0)}" dir="ltr">
      <span class="cur">${esc(curLabel(d.currency))}</span></label>
    <div class="chips center-chips" role="radiogroup" aria-label="${T('currency')}">${currencyChips(d.currency)}</div>
    <label class="field"><span>${T('note')}</span><input name="note" maxlength="140" placeholder="${T('notePh')}"></label>
    <button class="btn big ${dir > 0 ? 'pos' : 'neg'}" type="submit">${T('save')}</button>
  </form>`, (el) => el.addEventListener('change', (e) => {
    if (e.target.name === 'currency') $('.amount-field .cur', el).textContent = curLabel(e.target.value);
  }));
}

function disputeSheet(id) {
  sheet(`<form class="stack" data-form="dispute" data-id="${esc(id)}">
    <h2 class="sheet-title">${T('disputeTitle')}</h2>
    <label class="field"><span>${T('disputeReason')}</span>
      <input name="reason" maxlength="60" autofocus autocomplete="off" placeholder="${T('disputePh')}"></label>
    <small class="muted counter-chars" dir="ltr"><bdi>${nf().format(0)}</bdi>/${nf().format(60)}</small>
    <div class="row-btns"><button class="btn" type="button" data-close>${T('cancel')}</button>
      <button class="btn neg" type="submit">${T('disputeSend')}</button></div>
  </form>`, (el) => {
    const inp = $('input', el), n = $('.counter-chars bdi', el);
    inp.addEventListener('input', () => { n.textContent = nf().format(inp.value.length); });
  });
}

function confirmSheet({ title, body = '', ok, danger = false, onOk }) {
  sheet(`<div class="stack">
    <h2 class="sheet-title">${title}</h2>${body ? `<p class="muted">${body}</p>` : ''}
    <div class="row-btns"><button class="btn" data-close>${T('cancel')}</button>
    <button class="btn ${danger ? 'neg' : 'primary'}" data-ok>${ok || T('confirm')}</button></div></div>`,
  (el) => $('[data-ok]', el).addEventListener('click', async (e) => { e.currentTarget.disabled = true; await onOk(); }));
}

function shareSheet(first = false) {
  const d = current?.data;
  if (!d?.share_token) return;
  const url = linkFor(d.share_token);
  const text = T('shareText', d.me, d.friend);
  sheet(`<div class="stack share">
    <div class="share-art">${qamariya({ mood: moodOfB(balsOf(d)), variant: 'mini' })}</div>
    <h2 class="sheet-title">${T('shareTitle', esc(d.friend))}</h2>
    <p class="muted">${T('shareHint')}</p>
    <div class="linkbox" dir="ltr"><span>${esc(url)}</span></div>
    <div class="row-btns">
      <a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}" target="_blank" rel="noopener">${ICON.wa} ${T('whatsapp')}</a>
      <button class="btn" data-copy>${ICON.copy} ${T('copy')}</button>
    </div>
    ${navigator.share ? `<button class="btn ghost" data-native>${ICON.share} ${T('more')}</button>` : ''}
    ${first ? `<button class="btn link" data-close>${T('done')}</button>` : ''}
  </div>`, (el) => {
    $('[data-copy]', el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); } catch {
        const r = document.createRange(); r.selectNodeContents($('.linkbox span', el));
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy');
      }
      toast(T('copied'));
    });
    $('[data-native]', el)?.addEventListener('click', () => navigator.share({ title: T('appName'), text, url }).catch(() => {}));
  });
}

function menuSheet() {
  const d = current?.data;
  if (!d) return;
  sheet(`<form class="stack" data-form="rename">
    <h2 class="sheet-title">${esc(d.friend)}</h2>
    <label class="field"><span>${T('renameTab')}</span><input name="name" maxlength="40" required value="${esc(d.me)}"></label>
    <button class="btn primary" type="submit">${T('save')}</button>
    <button class="btn ghost neg-text" type="button" data-act="remove">${ICON.trash} ${T('remove')}</button>
  </form>`);
}

function welcomeSheet(d) {
  sheet(`<form class="stack center" data-form="welcome">
    <div class="share-art">${qamariya({ mood: 'even', variant: 'mini' })}</div>
    <h2 class="sheet-title">${T('welcome', esc(d.me))}</h2>
    <p class="muted">${T('welcomeBody', esc(d.friend))}</p>
    <label class="field"><span>${T('isThisYou')}</span><input name="name" maxlength="40" required value="${esc(d.me)}"></label>
    <button class="btn primary big" type="submit">${T('done')}</button>
    ${installHtml()}
  </form>`);
}

function installHtml() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return '';
  if (installPrompt) return `<button class="btn ghost" type="button" data-act="install">⬇ ${T('install')}</button>`;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return `<p class="muted small">${T('iosInstall')}</p>`;
  return '';
}

function settingsSheet() {
  const seg = (name, opts, val) => `<div class="seg">${opts.map(([v, l]) =>
    `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
  sheet(`<form class="stack" data-form="settings">
    <h2 class="sheet-title">${T('settings')}</h2>
    <label class="field"><span>${T('myNameLabel')}</span><input name="name" maxlength="40" value="${esc(settings.name)}"></label>
    <div class="field"><span>${T('language')}</span>${seg('lang', [['ar', 'العربية'], ['en', 'English']], settings.lang)}</div>
    <div class="field"><span>${T('numerals')}</span>${seg('nums', [['arab', '١٢٣'], ['latn', '123']], nums())}</div>
    <button class="btn primary" type="submit">${T('save')}</button>
    ${installHtml()}
  </form>`);
}

// ---------- toast & celebration ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
function celebrate() {
  const w = $('.counter .window');
  if (!w || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  w.classList.add('celebrate');
  const colors = ['#B8322A', '#E0A22B', '#2F7D5B', '#2C4A8A', '#2E8C8C'];
  for (let i = 0; i < 22; i++) {
    const s = document.createElement('i');
    s.className = 'shard';
    const a = Math.PI + Math.random() * Math.PI, dist = 90 + Math.random() * 110;
    s.style.cssText = `--dx:${Math.cos(a) * dist}px;--dy:${Math.sin(a) * dist}px;--r:${Math.random() * 360}deg;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.15}s`;
    w.appendChild(s);
  }
  setTimeout(() => { w.classList.remove('celebrate'); w.querySelectorAll('.shard').forEach((s) => s.remove()); }, 1500);
}

// ---------- events ----------
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { console.error(e); toast(T('error')); } finally { if (btn) btn.disabled = false; }
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'home') { closeSheet(true); location.hash = '#/'; }
  else if (act === 'open') location.hash = '#/t/' + el.dataset.token;
  else if (act === 'new') newTabSheet();
  else if (act === 'settings') settingsSheet();
  else if (act === 'lang') { settings.lang = settings.lang === 'ar' ? 'en' : 'ar'; saveSettings(); applyLang(); route(); }
  else if (act === 'add') entrySheet(Number(el.dataset.dir));
  else if (act === 'share') shareSheet();
  else if (act === 'menu') menuSheet();
  else if (act === 'install') { installPrompt?.prompt(); installPrompt = null; closeSheet(); }
  else if (act === 'settle') {
    const d = current.data;
    confirmSheet({ title: T('settleQ', esc(d.friend)), body: T('settleHint'), ok: T('settle'), onOk: async () => {
      const r = await busy(null, () => api.settle(current.token));
      closeSheet();
      if (r) { setData(r); toast(T('settledToast')); celebrate(); }
    } });
  }
  else if (act === 'dispute' && el.dataset.disputed !== '1') disputeSheet(el.dataset.id);
  else if (act === 'undo' || act === 'dispute') {
    const r = await busy(el, () => (act === 'undo' ? api.remove : api.dispute)(current.token, el.dataset.id));
    if (r) { setData(r); if (act === 'undo') toast(T('undone')); }
  }
  else if (act === 'remove') {
    const tok = current.token;
    confirmSheet({ title: T('remove'), body: T('removeQ'), danger: true, ok: T('remove'), onOk: () => {
      tabs = tabs.filter((x) => x.token !== tok); saveTabs(); LS.del('qy.snap.' + tok);
      closeSheet(true); toast(T('removed')); location.hash = '#/';
    } });
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form), kind = form.dataset.form, btn = form.querySelector('[type=submit]');

  if (kind === 'start') {
    settings.name = String(fd.get('name')).trim(); saveSettings(); renderHome(); newTabSheet();
  }
  else if (kind === 'new') {
    if (fd.get('me')) { settings.name = String(fd.get('me')).trim(); saveSettings(); }
    const friend = String(fd.get('friend')).trim(), cur = String(fd.get('currency') || 'YER');
    const r = await busy(btn, () => api.create(settings.name, friend, cur));
    if (!r) return;
    tabs.unshift({ token: r.token, friend, me: settings.name, currency: cur, balance: 0, side: 'a', shareToken: r.share_token });
    saveTabs();
    closeSheet(true);
    location.hash = '#/t/' + r.token;
    const wait = setInterval(() => { if (current?.data?.share_token) { clearInterval(wait); shareSheet(true); } }, 100);
    setTimeout(() => clearInterval(wait), 8000);
  }
  else if (kind === 'entry') {
    const amount = parseAmount(fd.get('amount'));
    const input = form.querySelector('[name=amount]');
    if (!amount || amount <= 0) { input.focus(); input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    const cur = String(fd.get('currency') || current.data.currency);
    const r = await busy(btn, () => api.add(current.token, amount * Number(form.dataset.dir), String(fd.get('note') || ''), cur));
    if (r) { closeSheet(); setData(r); if (moodOfB(balsOf(r)) === 'even') celebrate(); }
  }
  else if (kind === 'dispute') {
    const r = await busy(btn, () => api.dispute(current.token, form.dataset.id, String(fd.get('reason') || '').trim()));
    if (r) { closeSheet(); setData(r); }
  }
  else if (kind === 'rename' || kind === 'welcome') {
    const name = String(fd.get('name')).trim();
    if (name && name !== current.data.me) {
      const r = await busy(btn, () => api.rename(current.token, name));
      if (r) { setData(r); toast(T('saved')); }
    }
    if (!settings.name) { settings.name = name; saveSettings(); }
    closeSheet();
  }
  else if (kind === 'settings') {
    settings.name = String(fd.get('name') || '').trim();
    settings.lang = String(fd.get('lang'));
    settings.nums = String(fd.get('nums'));
    saveSettings(); applyLang(); closeSheet(true); route(); toast(T('saved'));
  }
});

// ---------- routing ----------
function route() {
  const m = location.hash.match(/^#\/t\/([\w-]{10,64})/);
  if (m) {
    if (current?.token === m[1]) renderCounter(); else openCounter(m[1]);
  } else { renderHome(); refreshHome(); }
}
window.addEventListener('hashchange', () => { closeSheet(true); route(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) current ? refresh() : refreshHome(); });
window.addEventListener('storage', (e) => { if (!isCloud && e.key === 'qy.demo.db') current ? refresh() : refreshHome(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

applyLang();
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
