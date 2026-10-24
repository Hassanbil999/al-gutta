// Data layer. Same API for the cloud (Supabase) and the on-device demo.
// Every call takes a tab token; the server figures out which side you are.

const cfg = window.QY_CONFIG || {};
export const isCloud = !!(cfg.supabaseUrl && cfg.supabaseKey);

async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: cfg.supabaseKey };
  if (cfg.supabaseKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + cfg.supabaseKey;
  const r = await fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers, body: JSON.stringify(args),
  });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).message; } catch {}
    const e = new Error(msg || 'HTTP ' + r.status);
    e.server = true;
    throw e;
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

const remote = {
  create: (me, friend, currency) => rpc('qy_create', { p_my_name: me, p_friend_name: friend, p_currency: currency }),
  get: (token) => rpc('qy_get', { p_token: token }),
  summaries: (tokens) => rpc('qy_summaries', { p_tokens: tokens }),
  add: (token, amount, note, currency) => rpc('qy_add', { p_token: token, p_amount: amount, p_note: note, p_currency: currency }),
  settle: (token) => rpc('qy_settle', { p_token: token }),
  remove: (token, id) => rpc('qy_remove', { p_token: token, p_id: id }),
  dispute: (token, id, reason = '') => rpc('qy_dispute', { p_token: token, p_id: id, p_reason: reason }),
  rename: (token, name) => rpc('qy_rename', { p_token: token, p_name: name }),
  split: (items, note, currency, total, count) => rpc('qy_split', { p_items: items, p_note: note, p_currency: currency, p_total: total, p_count: count }),
  inviteCreate: (name) => rpc('qy_invite_create', { p_name: name }),
  inviteInfo: (code) => rpc('qy_invite_info', { p_code: code }),
  inviteSet: (key, enabled, reset, name) => rpc('qy_invite_set', { p_key: key, p_enabled: enabled, p_reset: reset, p_name: name ?? null }),
  join: (code, name, currency) => rpc('qy_join', { p_code: code, p_name: name, p_currency: currency }),
  inviteRequests: (key) => rpc('qy_invite_requests', { p_key: key }),
  inviteDecide: (key, ledger, accept) => rpc('qy_invite_decide', { p_key: key, p_ledger: ledger, p_accept: accept }),
};

// ---- demo: mirrors supabase/schema.sql in localStorage ----

const DBK = 'qy.demo.db';
const load = () => { let db; try { db = JSON.parse(localStorage.getItem(DBK)); } catch {} db ||= { ledgers: [], entries: [] }; db.invites ||= []; return db; };
const save = (db) => { try { localStorage.setItem(DBK, JSON.stringify(db)); } catch {} };
const rid = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : rid());
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const r2 = (x) => Math.round(x * 100) / 100;
const now = () => new Date().toISOString();

function find(db, token) {
  const l = db.ledgers.find((l) => l.a_token === token || l.b_token === token);
  return l ? { l, s: l.a_token === token ? 'a' : 'b' } : null;
}
function balancesOf(db, l, sg) {
  const out = {};
  for (const e of db.entries) if (e.ledger_id === l.id && !e.deleted) {
    const c = e.currency || l.currency;
    out[c] = r2((out[c] || 0) + e.amount * sg);
  }
  for (const c of Object.keys(out)) if (!out[c]) delete out[c];
  return out;
}
function view(db, token) {
  const f = find(db, token);
  if (!f) return null;
  const { l, s } = f, sg = s === 'a' ? 1 : -1;
  return {
    ledger_id: l.id, side: s,
    me: s === 'a' ? l.a_name : l.b_name,
    friend: s === 'a' ? l.b_name : l.a_name,
    currency: l.currency, created_at: l.created_at, updated_at: l.updated_at,
    share_token: s === 'a' ? l.b_token : null,
    status: l.status || 'active',
    balance: balancesOf(db, l, sg)[l.currency] || 0,
    balances: balancesOf(db, l, sg),
    entries: db.entries.filter((e) => e.ledger_id === l.id && !e.deleted)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((e) => ({ id: e.id, amount: e.amount * sg, note: e.note, currency: e.currency || l.currency, mine: e.by_side === s, kind: e.kind, disputed: e.disputed, dispute_reason: e.dispute_reason || '', group_id: e.group_id || null, split_total: e.split_total ?? null, split_count: e.split_count ?? null, created_at: e.created_at })),
  };
}
function mutate(token, fn, any = false) {
  const db = load(), f = find(db, token);
  if (!f) throw new Error('not found');
  if (!any && (f.l.status || 'active') !== 'active') throw new Error('not active');
  fn(db, f.l, f.s);
  f.l.updated_at = now();
  save(db);
  return view(db, token);
}
const later = (fn) => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, 60));

const local = {
  create: (me, friend, currency) => later(() => {
    me = clean(me, 40); friend = clean(friend, 40);
    if (!me || !friend) throw new Error('name required');
    const db = load(), l = { id: uuid(), created_at: now(), updated_at: now(), currency, a_name: me, b_name: friend, a_token: rid(), b_token: rid() };
    db.ledgers.push(l); save(db);
    return { token: l.a_token, share_token: l.b_token };
  }),
  get: (token) => later(() => view(load(), token)),
  summaries: (tokens) => later(() => {
    const db = load();
    return tokens.map((t) => { const v = view(db, t); return v && { token: t, ...v, entries: undefined }; }).filter(Boolean);
  }),
  add: (token, amount, note, currency) => later(() => mutate(token, (db, l, s) => {
    amount = r2(amount);
    if (!amount || Math.abs(amount) > 1e12) throw new Error('bad amount');
    const cur = currency || l.currency;
    db.entries.push({ id: uuid(), ledger_id: l.id, created_at: now(), amount: amount * (s === 'a' ? 1 : -1), currency: cur, note: clean(note, 140), by_side: s, kind: 'entry', disputed: false, dispute_reason: '', deleted: false });
    l.currency = cur;
  })),
  settle: (token) => later(() => mutate(token, (db, l, s) => {
    for (const [cur, bal] of Object.entries(balancesOf(db, l, 1))) {
      db.entries.push({ id: uuid(), ledger_id: l.id, created_at: now(), amount: -bal, currency: cur, note: '', by_side: s, kind: 'settle', disputed: false, dispute_reason: '', deleted: false });
    }
  })),
  remove: (token, id) => later(() => mutate(token, (db, l, s) => {
    const e = db.entries.find((e) => e.id === id && e.ledger_id === l.id && e.by_side === s);
    if (e) e.deleted = true;
  })),
  dispute: (token, id, reason = '') => later(() => mutate(token, (db, l, s) => {
    const e = db.entries.find((e) => e.id === id && e.ledger_id === l.id && e.by_side !== s && e.kind === 'entry');
    if (e) { e.dispute_reason = e.disputed ? '' : clean(reason, 60); e.disputed = !e.disputed; }
  })),
  split: (items, note, currency, total, count) => later(() => {
    const db = load(), g = uuid(), out = [];
    for (const it of items) {
      const f = find(db, it.token);
      if (!f) throw new Error('not found');
      const amt = r2(it.amount);
      if (!(amt > 0) || amt > total) throw new Error('bad amount');
      const id = uuid();
      db.entries.push({ id, ledger_id: f.l.id, created_at: now(), amount: amt * (f.s === 'a' ? 1 : -1), currency, note: clean(note, 140), by_side: f.s, kind: 'entry', disputed: false, dispute_reason: '', deleted: false, group_id: g, split_total: r2(total), split_count: count });
      f.l.updated_at = now();
      out.push({ token: it.token, id, amount: amt });
    }
    save(db);
    return { group_id: g, items: out };
  }),
  inviteCreate: (name) => later(() => {
    const db = load(), i = { id: uuid(), owner_name: clean(name, 40), code: rid().slice(0, 16), owner_key: rid(), enabled: true };
    db.invites.push(i); save(db);
    return { code: i.code, key: i.owner_key, enabled: true, owner: i.owner_name };
  }),
  inviteInfo: (code) => later(() => { const i = load().invites.find((i) => i.code === code); return i ? { owner: i.owner_name, enabled: i.enabled } : null; }),
  inviteSet: (key, enabled, reset, name) => later(() => {
    const db = load(), i = db.invites.find((i) => i.owner_key === key);
    if (!i) return null;
    if (enabled != null) i.enabled = enabled;
    if (reset) i.code = rid().slice(0, 16);
    if (name && clean(name, 40)) i.owner_name = clean(name, 40);
    save(db);
    return { code: i.code, enabled: i.enabled, owner: i.owner_name };
  }),
  join: (code, name, currency) => later(() => {
    const db = load(), i = db.invites.find((i) => i.code === code);
    if (!i || !i.enabled) throw new Error('invite closed');
    name = clean(name, 40);
    if (!name) throw new Error('name required');
    const mine = db.ledgers.filter((l) => l.invite_id === i.id);
    if (mine.filter((l) => l.status === 'pending').length >= 20) throw new Error('too many requests');
    if (mine.filter((l) => Date.now() - Date.parse(l.created_at) < 600000).length >= 5) throw new Error('slow down');
    const l = { id: uuid(), created_at: now(), updated_at: now(), currency, a_name: i.owner_name, b_name: name, a_token: rid(), b_token: rid(), status: 'pending', invite_id: i.id };
    db.ledgers.push(l); save(db);
    return { token: l.b_token };
  }),
  inviteRequests: (key) => later(() => {
    const db = load(), i = db.invites.find((i) => i.owner_key === key);
    if (!i) return null;
    return { code: i.code, enabled: i.enabled, owner: i.owner_name,
      pending: db.ledgers.filter((l) => l.invite_id === i.id && l.status === 'pending').map((l) => ({ ledger_id: l.id, name: l.b_name, created_at: l.created_at })) };
  }),
  inviteDecide: (key, ledger, accept) => later(() => {
    const db = load(), i = db.invites.find((i) => i.owner_key === key);
    if (!i) throw new Error('not found');
    const ls = db.ledgers.filter((l) => l.invite_id === i.id && l.status === 'pending' && (ledger == null || l.id === ledger));
    if (!ls.length) return null;
    for (const l of ls) { l.status = accept ? 'active' : 'declined'; l.updated_at = now(); }
    save(db);
    return accept ? { token: ls[0].a_token } : { declined: true };
  }),
  rename: (token, name) => later(() => mutate(token, (db, l, s) => {
    name = clean(name, 40);
    if (!name) throw new Error('name required');
    if (s === 'a') l.a_name = name; else l.b_name = name;
  }, true)),
};

export const api = isCloud ? remote : local;
