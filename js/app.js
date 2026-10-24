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
  divide: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><circle class="fill" cx="12" cy="6.2" r="1.7"/><circle class="fill" cx="12" cy="17.8" r="1.7"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1.2-1.2"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};

// ---------- state ----------
const browserAr = (navigator.language || '').toLowerCase().startsWith('ar');
const settings = Object.assign({ lang: browserAr ? 'ar' : 'en', nums: null, name: '' }, LS.get('qy.settings', {}));
const saveSettings = () => LS.set('qy.settings', settings);
let tabs = LS.get('qy.tabs', []);
const saveTabs = () => LS.set('qy.tabs', tabs);
let splits = LS.get('qy.splits', []);   // group expenses I paid for (on this device)
const saveSplits = () => LS.set('qy.splits', splits);
let homeView = 'friends';      // 'friends' | 'splits'
let requests = [];             // people asking to open a tab through my invite link
let homeTimer = null;
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
const r2 = (x) => Math.round(x * 100) / 100;
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
    ledgerId: d.ledger_id, updatedAt: d.updated_at, shareToken: d.share_token ?? x.shareToken, lastCur: x.lastCur, status: d.status || 'active',
    settle: d.settle_request ? (d.settle_request.by_me ? 'mine' : 'theirs') : null,
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
      if (v > 0) c.plus = r2(c.plus + v); else c.minus = r2(c.minus - v);
    }
  }
  const curs = Object.keys(totals);
  const totalLines = (k) => curs.filter((c) => totals[c][k] > 0.004).map((c) => `<div>${money(totals[c][k], c)}</div>`).join('') || `<div class="zero">${money(0, curs[0] || tabs[0]?.currency || 'USD')}</div>`;
  app.innerHTML = `
  ${header({ title: T('appName'), actions: `<button class="icon-btn" data-act="invite" aria-label="${T('inviteTitle')}">${ICON.link}</button><button class="icon-btn" data-act="settings" aria-label="${T('settings')}">${ICON.gear}</button>` })}
  ${demoBanner()}
  ${requests.length ? `<button class="req-banner" data-act="requests"><span class="dot">${nf().format(requests.length)}</span> ${T('reqBanner', nf().format(requests.length))}</button>` : ''}
  <main class="home">
    ${tabs.length ? `
      <div class="seg home-seg" role="tablist">
        <button role="tab" data-act="view" data-v="friends" aria-pressed="${homeView === 'friends'}">${T('friendsTab')}</button>
        <button role="tab" data-act="view" data-v="splits" aria-pressed="${homeView === 'splits'}">${T('splits')}${splits.length ? ` <small>${nf().format(splits.length)}</small>` : ''}</button>
      </div>
      ${homeView === 'friends' ? `
      <section class="summary">
        <div class="sum plus"><small>${T('owedToYou')}</small>${totalLines('plus')}</div>
        <div class="sum minus"><small>${T('youOweTotal')}</small>${totalLines('minus')}</div>
      </section>
      <ul class="tabs">${tabs.map(tabRow).join('')}</ul>` : splitsList()}`
    : `<div class="empty-home">${qamariya({ mood: 'even', variant: 'mini' })}<p>${esc(T('homeEmpty')).replace('\n', '<br>')}</p></div>`}
  </main>
  <div class="fab-bar">
    ${tabs.length ? `<button class="fab alt" data-act="split">${ICON.divide} ${T('splitBtn')}</button>` : ''}
    <button class="fab" data-act="new"><span>+</span> ${T('addFriend')}</button>
  </div>`;
}

function splitsList() {
  if (!splits.length) return `<div class="empty-home"><span class="split-badge big">${ICON.divide}</span><p>${esc(T('noSplits')).replace('\n', '<br>')}</p></div>`;
  return `<ul class="tabs">${splits.map((g) => `<li><button class="tab-row" data-act="split-open" data-id="${esc(g.group_id)}">
    <span class="split-badge">${ICON.divide}</span>
    <span class="who"><b>${esc(g.note || T('split'))}</b><small><bdi>${when(g.created_at)}</bdi> · ${T('people', nf().format(g.count))}</small></span>
    <span class="amt">${money(g.total, g.currency)}</span>
  </button></li>`).join('')}</ul>`;
}

function tabRow(x) {
  const b = balsOf(x), mood = moodOfB(b);
  return `<li><button class="tab-row mood-${mood}" data-act="open" data-token="${esc(x.token)}">
    <span class="mini">${qamariya({ mood, variant: 'mini' })}</span>
    <span class="who"><b>${esc(x.friend)}</b><small>${x.status === 'pending' ? `<em class="wait">${T('waiting')}</em>` : x.status === 'declined' ? `<em class="wait no">${T('declinedShort')}</em>` : x.settle === 'theirs' ? `<em class="wait">✦ ${T('settleAskShort')}</em>` : x.settle === 'mine' ? `<em class="wait">${T('settleWaitShort')}</em>` : statusOfB(b, x.friend)}</small></span>
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
    ${d.status && d.status !== 'active' ? `<p class="banner ${d.status === 'declined' ? 'warn' : ''} pending-note">${d.status === 'pending' ? T('pendingNote', esc(d.friend)) : T('declinedNote', esc(d.friend))}</p>` : ''}
    <div class="actions" ${d.status && d.status !== 'active' ? 'hidden' : ''}>
      <button class="act plus" data-act="add" data-dir="1"><span class="big">${T('plus')}</span><small>${T('plusSub')}</small></button>
      <button class="act minus" data-act="add" data-dir="-1"><span class="big">${T('minus')}</span><small>${T('minusSub')}</small></button>
    </div>
    ${settleBox(d)}
    <div class="row2" ${d.status && d.status !== 'active' ? 'hidden' : ''}>
      ${mood !== 'even' && !d.settle_request ? `<button class="btn ghost" data-act="settle">✦ ${T('settle')}</button>` : ''}
      ${canShare ? `<button class="btn ghost" data-act="share">${ICON.share} ${T('share')}</button>` : ''}
    </div>
    <section class="history" ${d.status && d.status !== 'active' && !d.entries.length ? 'hidden' : ''}>
      <h2>${T('history')}</h2>
      ${d.entries.length ? `<ol>${d.entries.map((e) => entryRow(e, d, lastSettleAt(d))).join('')}</ol>`
                         : `<p class="muted center">${esc(T('empty')).replace('\n', '<br>')}</p>`}
    </section>
  </main>`;
}

function settleBox(d) {
  const r = d.settle_request;
  if (!r || (d.status && d.status !== 'active')) return '';
  const amounts = balList(r.balances || {}, d.currency).map(([c, v]) => signed(v, c)).join(' · ');
  if (r.by_me) return `<div class="settle-box mine">
      <p><b>${T('settleWaiting', esc(d.friend))}</b><span class="amts">${amounts}</span></p>
      <button class="btn ghost small-btn" data-act="settle-cancel">${T('settleCancel')}</button></div>`;
  return `<div class="settle-box theirs">
      <p><b>✦ ${T('settleAsked', esc(d.friend))}</b><span class="amts">${amounts}</span></p>
      <div class="row-btns"><button class="btn small-btn" data-act="settle-no">${T('settleNo')}</button>
      <button class="btn pos small-btn" data-act="settle-yes">${T('settleYes')}</button></div></div>`;
}

// entries from before a confirmed settle are closed: no undo, no dispute
const lastSettleAt = (d) => d.entries.reduce((m, e) => (e.kind === 'settle' && e.created_at > m ? e.created_at : m), '');

function entryRow(e, d, settledAt = '') {
  const who = e.mine ? T('you') : esc(d.friend);
  const closed = e.created_at < settledAt;
  const other = e.mine ? esc(d.friend) : T('you');
  if (e.kind === 'settle') {
    return `<li class="entry settle">
      <span class="sign">✦</span>
      <span class="meta"><b>${T('settled')}</b><small><bdi>${when(e.created_at)}</bdi> · ${T('settledBy', who, other)}</small></span>
      <span class="amt">${money(e.amount, e.currency || d.currency)}</span>
      <span class="ops"></span>
    </li>`;
  }
  if (e.deleted) {
    return `<li class="entry gone">
      <span class="sign">↶</span>
      <span class="meta"><b>${esc(e.note) || (e.amount > 0 ? T('lentPos') : T('lentNeg'))}</b><small>${T('undoneBy', who)} · <bdi>${when(e.deleted_at || e.created_at)}</bdi></small></span>
      <span class="amt">${money(e.amount, e.currency || d.currency)}</span>
      <span class="ops"></span>
    </li>`;
  }
  const pos = e.amount > 0;
  return `<li class="entry ${pos ? 'pos' : 'neg'} ${e.disputed ? 'disputed' : ''}">
    <span class="sign">${pos ? '+' : '−'}</span>
    <span class="meta"><b>${esc(e.note) || (pos ? T('lentPos') : T('lentNeg'))}</b>
      <small><bdi>${who}</bdi> · <bdi>${when(e.created_at)}</bdi>${e.disputed ? ` · <em>${T('disputed')}</em>` : ''}</small>
      ${e.group_id && e.split_total ? `<span class="split-tag">${T('splitTag', money(e.split_total, e.currency || d.currency), nf().format(e.split_count))}</span>` : ''}
      ${e.disputed && e.dispute_reason ? `<span class="reason">«<bdi>${esc(e.dispute_reason)}</bdi>»</span>` : ''}</span>
    <span class="amt">${money(e.amount, e.currency || d.currency)}</span>
    <span class="ops">${closed ? '' : e.mine
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
    const before = c.data?.settle_request, after = d.settle_request;
    let cheer = false;
    if (c.data && before?.by_me && !after) {
      if (moodOfB(balsOf(d)) === 'even') { toast(T('settleConfirmed', d.friend)); cheer = true; } else toast(T('settleDropped'));
    } else if (c.data && !before && after && !after.by_me) toast(T('settleAsked', d.friend));
    const changed = JSON.stringify(d) !== JSON.stringify(c.data) || c.offline;
    c.data = d; c.offline = false; c.missing = false;
    LS.set('qy.snap.' + c.token, d);
    upsertTab(c.token, d);
    if (!settings.name) { settings.name = d.me; saveSettings(); }
    if (changed) renderCounter();
    if (cheer) celebrate();
    if (first && d.side === 'b' && d.status !== 'pending') welcomeSheet(d);
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

async function refreshRequests() {
  if (!settings.invite?.key) { requests = []; return; }
  try {
    const r = await api.inviteRequests(settings.invite.key);
    if (!r) return;
    const changed = JSON.stringify(r.pending) !== JSON.stringify(requests);
    requests = r.pending || [];
    Object.assign(settings.invite, { code: r.code, enabled: r.enabled }); saveSettings();
    if (changed && !current) renderHome();
  } catch {}
}
function startHomePoll() {
  clearInterval(homeTimer);
  homeTimer = setInterval(() => { if (!current && !document.hidden && !sheetRoot.classList.contains('open')) { refreshHome(); } }, isCloud ? 12000 : 3000);
}

async function refreshHome() {
  refreshRequests();
  if (!tabs.length) return;
  try {
    const list = await api.summaries(tabs.map((x) => x.token));
    let changed = false;
    for (const s of list || []) {
      const x = tabs.find((x) => x.token === s.token);
      if (x && (JSON.stringify(x.balances) !== JSON.stringify(s.balances) || x.friend !== s.friend || x.updatedAt !== s.updated_at || (x.status || 'active') !== (s.status || 'active') || (x.settle || null) !== (s.settle || null))) {
        Object.assign(x, { balances: s.balances, friend: s.friend, me: s.me, currency: s.currency, updatedAt: s.updated_at, ledgerId: s.ledger_id, side: s.side, status: s.status || 'active', settle: s.settle || null });
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

const currencyChips = (sel) => Object.keys(CURRENCIES).filter((c) => !CURRENCIES[c].hidden || c === sel).map((c) =>
  `<label class="chip"><input type="radio" name="currency" value="${c}" ${c === sel ? 'checked' : ''}><span>${CURRENCIES[c][settings.lang]}</span></label>`).join('');

function newTabSheet() {
  sheet(`<form class="stack" data-form="new">
    <h2 class="sheet-title">${T('addFriend')}</h2>
    ${settings.name ? '' : `<label class="field"><span>${T('yourName')}</span><input name="me" maxlength="40" required></label>`}
    <label class="field"><span>${T('friendName')}</span><input name="friend" maxlength="40" required autofocus placeholder="${T('friendPh')}"></label>
    <div class="field"><span>${T('currency')}</span><div class="chips">${currencyChips(tabs[0]?.currency || 'USD')}</div></div>
    <button class="btn primary big" type="submit">${T('create')}</button>
  </form>`);
}

// the currency I used last with this friend (falls back to the tab's last one)
const myCur = () => tabs.find((x) => x.token === current?.token)?.lastCur || current?.data?.currency || 'USD';

function entrySheet(dir) {
  const d = current?.data;
  if (!d) return;
  sheet(`<form class="stack entry-form ${dir > 0 ? 'plus' : 'minus'}" data-form="entry" data-dir="${dir}">
    <h2 class="sheet-title">${dir > 0 ? T('owesYou', esc(d.friend)) : T('youOwe', esc(d.friend))}</h2>
    <label class="amount-field"><span class="sr">${T('amount')}</span>
      <input name="amount" inputmode="decimal" autocomplete="off" required autofocus placeholder="${nf().format(0)}" dir="ltr">
      <span class="cur">${esc(curLabel(myCur()))}</span></label>
    <div class="chips center-chips" role="radiogroup" aria-label="${T('currency')}">${currencyChips(myCur())}</div>
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

// ---------- القطة: split one payment between friends ----------
// Shares: fixed amounts first, the rest is divided equally; any rounding leftover goes to the first
// equal-share person (me, when I'm included), so the shares always add up to the total.
function computeShares(total, parts, cur) {
  const unit = cur === 'YER' || cur === 'LBP' ? 1 : 100;   // no small coins in use
  const fixed = parts.filter((p) => p.custom != null), free = parts.filter((p) => p.custom == null);
  const rest = r2(total - fixed.reduce((a, p) => a + p.custom, 0));
  if (rest < 0) return { error: 'splitOver' };
  if (!free.length && Math.abs(rest) >= 0.005) return { error: 'splitMismatch' };
  const each = free.length ? Math.floor((rest * unit) / free.length + 1e-9) / unit : 0;
  const extra = r2(rest - each * free.length);
  const shares = {};
  for (const p of fixed) shares[p.key] = p.custom;
  free.forEach((p, i) => { shares[p.key] = i === 0 ? r2(each + extra) : each; });
  return { shares, each };
}

function splitSheet() {
  const cur0 = tabs[0]?.lastCur || tabs[0]?.currency || 'USD';
  sheet(`<form class="stack split-form" data-form="split" novalidate>
    <h2 class="sheet-title">${T('newSplit')}</h2>
    <label class="field"><span>${T('totalPaid')}</span></label>
    <label class="amount-field" style="margin-top:-8px"><span class="sr">${T('totalPaid')}</span>
      <input name="total" inputmode="decimal" autocomplete="off" autofocus placeholder="${nf().format(0)}" dir="ltr">
      <span class="cur">${esc(curLabel(cur0))}</span></label>
    <div class="chips center-chips">${currencyChips(cur0)}</div>
    <label class="field"><span>${T('note')}</span><input name="note" maxlength="140" placeholder="${T('splitNotePh')}"></label>
    <div class="field"><span>${T('splitWho')}</span>
      <div class="chips people">
        <label class="chip me"><input type="checkbox" name="me" checked><span>${T('you')}</span></label>
        ${tabs.map((x) => `<label class="chip"><input type="checkbox" name="p" value="${esc(x.token)}"><span>${esc(x.friend)}</span></label>`).join('')}
      </div></div>
    <div class="breakdown"></div>
    <p class="muted small split-hint">${T('splitRest')}</p>
    <p class="split-error" role="alert"></p>
    <button class="btn primary big" type="submit" disabled>${T('splitGo0')}</button>
  </form>`, (el) => {
    const custom = {};
    const totalIn = $('[name=total]', el), bd = $('.breakdown', el), err = $('.split-error', el), go = $('[type=submit]', el);
    const cur = () => $('[name=currency]:checked', el)?.value || cur0;
    const parts = () => {
      const out = [];
      if ($('[name=me]', el).checked) out.push({ key: 'me', name: T('you') });
      el.querySelectorAll('[name=p]:checked').forEach((c) => out.push({ key: c.value, name: tabs.find((x) => x.token === c.value)?.friend || '' }));
      return out.map((p) => ({ ...p, custom: custom[p.key] ?? null }));
    };
    const rows = () => {
      bd.innerHTML = parts().map((p) => `<div class="share-row">
        <span class="nm">${esc(p.name)}</span>
        <input data-key="${esc(p.key)}" inputmode="decimal" autocomplete="off" dir="ltr" value="${custom[p.key] != null ? custom[p.key] : ''}" aria-label="${esc(p.name)}">
        <span class="cur">${esc(curLabel(cur()))}</span></div>`).join('');
      update();
    };
    const update = () => {
      const total = parseAmount(totalIn.value), ps = parts(), friends = ps.filter((p) => p.key !== 'me');
      $('.amount-field .cur', el).textContent = curLabel(cur());
      bd.querySelectorAll('.cur').forEach((c) => { c.textContent = curLabel(cur()); });
      let msg = '', ok = false;
      if (!friends.length) msg = T('pickOne');
      else if (!(total > 0)) msg = '';
      else {
        const r = computeShares(total, ps, cur());
        if (r.error) msg = T(r.error);
        else {
          bd.querySelectorAll('input[data-key]').forEach((i) => { i.placeholder = nf().format(r.shares[i.dataset.key] ?? 0); });
          const charged = friends.filter((p) => r.shares[p.key] > 0);
          ok = charged.length > 0;
          if (!ok) msg = T('splitMismatch');
          el._result = { total, shares: r.shares, parts: ps, charged };
          go.textContent = ok ? T('splitGo', nf().format(charged.length)) : T('splitGo0');
        }
      }
      err.textContent = msg;
      go.disabled = !ok;
      if (!ok) el._result = null;
    };
    el.addEventListener('change', (e) => {
      if (e.target.name === 'me' || e.target.name === 'p') rows();
      else if (e.target.name === 'currency') update();
    });
    el.addEventListener('input', (e) => {
      if (e.target.dataset.key) {
        const v = e.target.value.trim();
        if (v === '') delete custom[e.target.dataset.key];
        else { const n = parseAmount(v); if (Number.isFinite(n) && n >= 0) custom[e.target.dataset.key] = n; }
      }
      update();
    });
    rows();
  });
}

function splitDetail(id) {
  const g = splits.find((x) => x.group_id === id);
  if (!g) return;
  const line = (name, amt, cls = '') => `<li class="${cls}"><span>${name}</span>${money(amt, g.currency)}</li>`;
  sheet(`<div class="stack">
    <h2 class="sheet-title">${esc(g.note || T('split'))}</h2>
    <p class="muted"><bdi>${when(g.created_at)}</bdi> · ${money(g.total, g.currency)} · ${T('people', nf().format(g.count))}</p>
    <ul class="split-lines">
      ${g.me ? line(T('mine'), g.me, 'me') : ''}
      ${g.items.map((it) => line(esc(it.friend), it.amount)).join('')}
    </ul>
    <button class="btn ghost neg-text" data-act="split-undo" data-id="${esc(g.group_id)}">${ICON.trash} ${T('undoSplit')}</button>
  </div>`);
}

// ---------- public invite link ----------
const joinLink = (code) => location.origin + location.pathname.replace(/index\.html$/, '') + '#/join/' + code;

function inviteSheet() {
  const inv = settings.invite;
  if (!inv) {
    sheet(`<div class="stack center">
      <div class="share-art">${qamariya({ mood: 'even', variant: 'mini' })}</div>
      <h2 class="sheet-title">${T('inviteTitle')}</h2>
      <p class="muted">${T('inviteIntro')}</p>
      <ul class="guard">${T('inviteGuards').map((g) => `<li>${g}</li>`).join('')}</ul>
      <button class="btn primary big" data-act="invite-create">${ICON.link} ${T('inviteCreate')}</button>
    </div>`);
    return;
  }
  const url = joinLink(inv.code);
  const text = settings.inviteMsg || T('inviteText', settings.name || '');
  sheet(`<div class="stack share">
    <div class="share-art">${qamariya({ mood: inv.enabled ? 'even' : 'minus', variant: 'mini' })}</div>
    <h2 class="sheet-title">${T('inviteTitle')}</h2>
    <p class="muted">${inv.enabled ? T('inviteOn') : T('inviteOffNote')}</p>
    ${inv.enabled ? `<label class="field"><span>${T('inviteMsg')}</span>
      <textarea name="invite-msg" rows="4" maxlength="400">${esc(text)}</textarea></label>` : ''}
    <div class="linkbox ${inv.enabled ? '' : 'off'}" dir="ltr"><span>${esc(url)}</span></div>
    ${inv.enabled ? `<div class="row-btns">
      <a class="btn wa" data-wa href="https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}" target="_blank" rel="noopener">${ICON.wa} ${T('whatsapp')}</a>
      <button class="btn" data-copy>${ICON.copy} ${T('copy')}</button></div>
      ${navigator.share ? `<button class="btn ghost" data-native>${ICON.share} ${T('more')}</button>` : ''}` : ''}
    <div class="row-btns">
      <button class="btn ghost" data-act="invite-toggle">${inv.enabled ? T('inviteOff') : T('inviteOnBtn')}</button>
      <button class="btn ghost neg-text" data-act="invite-reset">${T('inviteReset')}</button>
    </div>
    <p class="muted small">${T('inviteSafety')}</p>
  </div>`, (el) => {
    // the message travels with the link; edits are remembered on this phone
    const msg = () => ($('[name=invite-msg]', el)?.value.trim() || T('inviteText', settings.name || ''));
    $('[name=invite-msg]', el)?.addEventListener('input', () => {
      const v = $('[name=invite-msg]', el).value.trim();
      settings.inviteMsg = v && v !== T('inviteText', settings.name || '') ? v : ''; saveSettings();
      $('[data-wa]', el).href = 'https://wa.me/?text=' + encodeURIComponent(msg() + '\n' + url);
    });
    $('[data-copy]', el)?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(msg() + '\n' + url); toast(T('copied')); } catch { toast(url); }
    });
    $('[data-native]', el)?.addEventListener('click', () => navigator.share({ title: T('appName'), text: msg(), url }).catch(() => {}));
  });
}

function requestsSheet() {
  if (!requests.length) { closeSheet(); return; }
  sheet(`<div class="stack">
    <h2 class="sheet-title">${T('reqTitle')}</h2>
    <p class="muted small">${T('reqHint')}</p>
    <ul class="req-list">${requests.map((r) => `<li>
      <span class="who"><b>${esc(r.name)}</b><small><bdi>${when(r.created_at)}</bdi></small></span>
      <button class="btn small-btn" data-act="req-no" data-id="${esc(r.ledger_id)}">${T('decline')}</button>
      <button class="btn pos small-btn" data-act="req-yes" data-id="${esc(r.ledger_id)}">${T('accept')}</button>
    </li>`).join('')}</ul>
    ${requests.length > 1 ? `<button class="btn ghost neg-text" data-act="req-none">${T('declineAll')}</button>` : ''}
  </div>`);
}

function renderJoin(code) {
  stopPoll(); current = null;
  app.innerHTML = `
  <main class="onboard join">
    <button class="lang-pill" data-act="lang">${settings.lang === 'ar' ? 'English' : 'العربية'}</button>
    <div class="hero">${qamariya({ mood: 'even', variant: 'full' })}</div>
    <h1 class="hero-title small-title">القطة ياعبدو</h1>
    <div class="join-body"><p class="muted center">…</p></div>
  </main>`;
  const body = $('.join-body');
  if (settings.invite?.code === code) {
    body.innerHTML = `<p class="tagline">${T('ownInvite')}</p><button class="btn primary" data-act="home">${T('backHome')}</button>`;
    return;
  }
  api.inviteInfo(code).then((info) => {
    if (!info || !info.enabled) {
      body.innerHTML = `<p class="tagline">${T('inviteClosed')}</p><button class="btn" data-act="home">${T('backHome')}</button>`;
      return;
    }
    body.innerHTML = `
      <p class="tagline"><b>${T('joinTitle', esc(info.owner))}</b><br>${T('joinBody', esc(info.owner))}</p>
      <form class="stack" data-form="join" data-code="${esc(code)}">
        <label class="field"><span>${T('yourName')}</span>
          <input name="name" maxlength="40" required autocomplete="given-name" value="${esc(settings.name)}" placeholder="${T('namePh')}"></label>
        <div class="field"><span>${T('currency')}</span><div class="chips">${currencyChips('USD')}</div></div>
        <button class="btn primary big" type="submit">${T('joinBtn')}</button>
      </form>`;
  }).catch(() => { body.innerHTML = `<p class="tagline">${T('error')}</p>`; });
}

// ---------- first-use tutorial ----------
const tourSeen = () => !!LS.get('qy.tour', 0);
const TOUR_OWNER = ['welcome', 'add', 'share', 'plusminus', 'split', 'dispute', 'settle'];
const TOUR_GUEST = ['guest', 'plusminus', 'dispute', 'settle'];

function tourArt(k) {
  const mini = (m = 'even') => qamariya({ mood: m, variant: 'mini' });
  switch (k) {
    case 'welcome': case 'guest':
      return `<div class="ta-win mood-even">${qamariya({ mood: 'even', variant: 'full' })}</div>`;
    case 'add':
      return `<div class="ta-card ta-i1"><span class="ta-mini">${mini()}</span><b>${settings.lang === 'ar' ? 'عبدو' : 'Abdo'}</b><small>${T('even')}</small></div>
              <div class="ta-pill ta-i2">+ ${T('addFriend')}</div>`;
    case 'share':
      return `<div class="ta-bubble ta-i1" dir="ltr">🔗 al-gutta/#/t/…</div>
              <div class="ta-row ta-i2"><span class="ta-btn wa">${ICON.wa} ${T('whatsapp')}</span><span class="ta-btn">${ICON.link}</span></div>`;
    case 'plusminus':
      return `<div class="ta-amt ta-i1">${money(3000, 'USD')}</div>
              <div class="ta-row ta-i2"><span class="act plus"><span class="big">${T('plus')}</span></span><span class="act minus"><span class="big">${T('minus')}</span></span></div>
              <div class="ta-row ta-i3 chips">${['USD', 'LBP', 'YER', 'SAR'].map((c, i) => `<span class="chip"><span class="${i ? '' : 'on'}">${esc(curLabel(c))}</span></span>`).join('')}</div>`;
    case 'split':
      return `<span class="split-badge big ta-i1">${ICON.divide}</span>
              <div class="ta-row ta-i2">${[T('you'), settings.lang === 'ar' ? 'عبدو' : 'Abdo', settings.lang === 'ar' ? 'علي' : 'Ali'].map((n, i) =>
                `<span class="ta-av"><i style="background:${['#7A4A2E', '#2F7D5B', '#2C4A8A'][i]}">${esc(n.slice(0, 1))}</i><small>${esc(n)}</small><b>${money(30, 'USD')}</b></span>`).join('')}</div>`;
    case 'dispute':
      return `<div class="ta-entry ta-i1"><span class="sign">+</span><span><b>${settings.lang === 'ar' ? 'غداء' : 'Lunch'}</b><small>${T('disputed')}</small></span><span class="amt">${money(30, 'USD')}</span></div>
              <span class="reason ta-i2">«${T('tourReasonEx')}»</span>`;
    case 'settle':
      return `<div class="ta-win small mood-even ta-i1">${qamariya({ mood: 'even', variant: 'full' })}</div>
              <div class="ta-zero ta-i2">${settings.lang === 'ar' ? 'صفر' : '0'} <small>${T('even')}</small></div>`;
  }
  return '';
}

function tour(kind = 'owner', onDone) {
  document.getElementById('tour')?.remove();
  const keys = kind === 'guest' ? TOUR_GUEST : TOUR_OWNER;
  const slides = keys.map((k) => ({ k, ...T('tour')[k] }));
  const el = document.createElement('div');
  el.id = 'tour';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', T('tourLabel'));
  el.innerHTML = `
    <div class="tour-top"><span class="tour-count" dir="ltr"></span><button class="tour-skip" data-t="skip">${T('tourSkip')}</button></div>
    <div class="tour-view"><div class="tour-track">${slides.map((s) => `
      <section class="tour-slide" aria-hidden="true">
        <div class="tour-art">${tourArt(s.k)}</div>
        <h2>${s.t}</h2><p>${s.b}</p>
      </section>`).join('')}</div></div>
    <div class="tour-dots">${slides.map((_, i) => `<button data-t="dot" data-i="${i}" aria-label="${i + 1}"></button>`).join('')}</div>
    <div class="tour-nav">
      <button class="btn ghost" data-t="back">${T('tourBack')}</button>
      <button class="btn primary big" data-t="next"></button>
    </div>`;
  document.body.appendChild(el);
  const track = $('.tour-track', el), secs = [...el.querySelectorAll('.tour-slide')], dots = [...el.querySelectorAll('.tour-dots button')];
  const rtl = document.documentElement.dir === 'rtl';
  let i = 0;
  const go = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    track.style.transform = `translateX(${(rtl ? 1 : -1) * i * 100}%)`;
    secs.forEach((s, j) => { s.classList.toggle('active', j === i); s.setAttribute('aria-hidden', j === i ? 'false' : 'true'); });
    dots.forEach((d, j) => d.classList.toggle('on', j === i));
    $('[data-t=back]', el).style.visibility = i ? 'visible' : 'hidden';
    $('[data-t=next]', el).textContent = i === slides.length - 1 ? T('tourStart') : T('tourNext');
    $('.tour-count', el).textContent = `${nf().format(i + 1)} / ${nf().format(slides.length)}`;
  };
  const finish = () => {
    LS.set('qy.tour', 1);
    el.classList.add('out');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => el.remove(), 250);
    onDone?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowLeft') go(i + (rtl ? 1 : -1));
    else if (e.key === 'ArrowRight') go(i + (rtl ? -1 : 1));
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const a = b.dataset.t;
    if (a === 'skip') finish();
    else if (a === 'next') (i === slides.length - 1 ? finish() : go(i + 1));
    else if (a === 'back') go(i - 1);
    else if (a === 'dot') go(Number(b.dataset.i));
  });
  // swipe
  let x0 = null;
  el.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  el.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) go(i + ((dx < 0) !== rtl ? 1 : -1));
  });
  go(0);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => $('[data-t=next]', el).focus(), 300);
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
    <button class="btn ghost" type="button" data-act="tour">✦ ${T('tourAgain')}</button>
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
  else if (act === 'split') splitSheet();
  else if (act === 'view') { homeView = el.dataset.v; renderHome(); }
  else if (act === 'split-open') splitDetail(el.dataset.id);
  else if (act === 'split-undo') {
    const g = splits.find((x) => x.group_id === el.dataset.id);
    if (!g) return;
    confirmSheet({ title: T('undoSplit'), body: T('undoSplitQ'), danger: true, ok: T('undo'), onOk: async () => {
      const ok = await busy(null, () => Promise.all(g.items.map((it) => api.remove(it.token, it.id))));
      closeSheet(true);
      if (ok) {
        splits = splits.filter((x) => x !== g); saveSplits();
        toast(T('splitUndone')); renderHome(); refreshHome();
      }
    } });
  }
  else if (act === 'settings') settingsSheet();
  else if (act === 'invite') inviteSheet();
  else if (act === 'tour') { closeSheet(true); tour(current?.data?.side === 'b' && !tabs.some((x) => x.side === 'a') ? 'guest' : 'owner'); }
  else if (act === 'requests') requestsSheet();
  else if (act === 'invite-create') {
    if (!settings.name) { closeSheet(); settingsSheet(); return; }
    const r = await busy(el, () => api.inviteCreate(settings.name));
    if (r) { settings.invite = { code: r.code, key: r.key, enabled: r.enabled }; saveSettings(); inviteSheet(); }
  }
  else if (act === 'invite-toggle' || act === 'invite-reset') {
    const doIt = async () => {
      const r = await busy(el, () => api.inviteSet(settings.invite.key, act === 'invite-toggle' ? !settings.invite.enabled : null, act === 'invite-reset'));
      if (r) { Object.assign(settings.invite, { code: r.code, enabled: r.enabled }); saveSettings(); toast(T('saved')); inviteSheet(); }
    };
    if (act === 'invite-reset') confirmSheet({ title: T('inviteReset'), body: T('inviteResetQ'), danger: true, ok: T('inviteReset'), onOk: doIt });
    else doIt();
  }
  else if (act === 'req-yes' || act === 'req-no' || act === 'req-none') {
    const accept = act === 'req-yes', id = act === 'req-none' ? null : el.dataset.id;
    const r = await busy(el, () => api.inviteDecide(settings.invite.key, id, accept));
    requests = act === 'req-none' ? [] : requests.filter((x) => x.ledger_id !== id);
    if (accept && r?.token) {
      const d = await api.get(r.token).catch(() => null);
      if (d) { upsertTab(r.token, d); tabs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))); saveTabs(); }
      toast(T('accepted'));
    }
    renderHome();
    if (requests.length) requestsSheet(); else closeSheet();
  }
  else if (act === 'lang') { settings.lang = settings.lang === 'ar' ? 'en' : 'ar'; saveSettings(); applyLang(); route(); }
  else if (act === 'add') entrySheet(Number(el.dataset.dir));
  else if (act === 'share') shareSheet();
  else if (act === 'menu') menuSheet();
  else if (act === 'install') { installPrompt?.prompt(); installPrompt = null; closeSheet(); }
  else if (act === 'settle') {
    const d = current.data;
    confirmSheet({ title: T('settleQ', esc(d.friend)), body: T('settleHint', esc(d.friend)), ok: T('settleSend'), onOk: async () => {
      const r = await busy(null, () => api.settle(current.token));
      closeSheet();
      if (!r) return;
      setData(r);
      if (moodOfB(balsOf(r)) === 'even') { toast(T('settledToast')); celebrate(); } else toast(T('settleSent', d.friend));
    } });
  }
  else if (act === 'settle-yes' || act === 'settle-no' || act === 'settle-cancel') {
    const r = await busy(el, () => api.settleAnswer(current.token, act === 'settle-yes'));
    if (!r) return;
    if (r.changed) { toast(T('settleChanged')); refresh(); return; }
    setData(r);
    if (act === 'settle-yes') { toast(T('settledToast')); celebrate(); }
    else toast(act === 'settle-no' ? T('settleDeclined') : T('settleCancelled'));
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
    settings.name = String(fd.get('name')).trim(); saveSettings(); renderHome();
    if (tourSeen()) newTabSheet(); else tour('owner', () => newTabSheet());
  }
  else if (kind === 'new') {
    if (fd.get('me')) { settings.name = String(fd.get('me')).trim(); saveSettings(); }
    const friend = String(fd.get('friend')).trim(), cur = String(fd.get('currency') || 'USD');
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
    const cur = String(fd.get('currency') || myCur());
    const tab = tabs.find((x) => x.token === current.token);
    if (tab) { tab.lastCur = cur; saveTabs(); }
    const r = await busy(btn, () => api.add(current.token, amount * Number(form.dataset.dir), String(fd.get('note') || ''), cur));
    if (r) { closeSheet(); setData(r); if (moodOfB(balsOf(r)) === 'even') celebrate(); }
  }
  else if (kind === 'split') {
    const res = form.closest('.sheet')?._result;
    if (!res) return;
    const cur = String(fd.get('currency'));
    const note = String(fd.get('note') || '').trim();
    const items = res.charged.map((p) => ({ token: p.key, amount: res.shares[p.key] }));
    const r = await busy(btn, () => api.split(items, note || T('split'), cur, res.total, res.parts.length));
    if (!r) return;
    splits.unshift({
      group_id: r.group_id, created_at: new Date().toISOString(), note, currency: cur, total: res.total,
      count: res.parts.length, me: res.shares.me || 0,
      items: r.items.map((it) => ({ ...it, friend: tabs.find((x) => x.token === it.token)?.friend || '' })),
    });
    saveSplits();
    for (const it of items) { const t = tabs.find((x) => x.token === it.token); if (t) { t.lastCur = cur; } }
    saveTabs();
    closeSheet(true);
    homeView = 'splits';
    toast(T('splitDone'));
    renderHome();
    refreshHome();
  }
  else if (kind === 'join') {
    const name = String(fd.get('name')).trim(), cur = String(fd.get('currency') || 'USD');
    try {
      btn.disabled = true;
      const r = await api.join(form.dataset.code, name, cur);
      if (!settings.name) { settings.name = name; saveSettings(); }
      tabs.unshift({ token: r.token, friend: '', me: name, currency: cur, balance: 0, side: 'b', status: 'pending' });
      saveTabs();
      location.replace('#/t/' + r.token);
      if (!tourSeen()) setTimeout(() => tour('guest'), 500);
    } catch (err) {
      btn.disabled = false;
      const m = String(err.message || '');
      toast(m.includes('slow') || m.includes('too many') ? T('joinBusy') : m.includes('closed') ? T('inviteClosed') : T('error'));
    }
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
    if (kind === 'welcome' && !tourSeen()) setTimeout(() => tour('guest'), 300);
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
  const j = location.hash.match(/^#\/join\/([\w-]{8,64})/);
  if (j) { clearInterval(homeTimer); return renderJoin(j[1]); }
  const m = location.hash.match(/^#\/t\/([\w-]{10,64})/);
  if (m) {
    if (current?.token === m[1]) renderCounter(); else openCounter(m[1]);
  } else {
    renderHome(); refreshHome(); startHomePoll();
    if (settings.name && !tourSeen() && !document.getElementById('tour')) tour('owner');
  }
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
