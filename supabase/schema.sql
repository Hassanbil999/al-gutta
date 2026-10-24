-- القطة ياعبدو — database schema
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to re-run (also upgrades older versions).
--
-- Security model: there are no user accounts. Each tab has two secret tokens,
-- one per person. The tables are locked (RLS on, no policies), so the only way
-- in is through the functions below, and each function needs a valid token.

create table if not exists public.qy_ledgers (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  currency    text not null default 'USD',     -- last currency used (default for the next entry)
  a_name      text not null,
  b_name      text not null,
  a_token     text not null unique,
  b_token     text not null unique
);

create table if not exists public.qy_entries (
  id          uuid primary key default gen_random_uuid(),
  ledger_id   uuid not null references public.qy_ledgers(id) on delete cascade,
  created_at  timestamptz not null default now(),
  amount      numeric(16,2) not null,          -- positive = B owes A
  note        text not null default '',
  by_side     char(1) not null check (by_side in ('a','b')),
  kind        text not null default 'entry' check (kind in ('entry','settle')),
  disputed    boolean not null default false,
  deleted     boolean not null default false
);
-- v2: each entry has its own currency, and a dispute can carry a short reason
alter table public.qy_entries add column if not exists currency text;
alter table public.qy_entries add column if not exists dispute_reason text not null default '';
update public.qy_entries e set currency = l.currency
  from public.qy_ledgers l where e.ledger_id = l.id and e.currency is null;
-- v3: group splits (قطة) — entries from one shared expense carry the same group_id
alter table public.qy_entries add column if not exists group_id uuid;
alter table public.qy_entries add column if not exists split_total numeric(16,2);
alter table public.qy_entries add column if not exists split_count int;

-- v4: one public invite link per person; joining creates a *pending* tab the owner must accept
create table if not exists public.qy_invites (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  owner_name  text not null,
  code        text not null unique,      -- public, goes in the link
  owner_key   text not null unique,      -- secret, stays on the owner's phone
  enabled     boolean not null default true
);
alter table public.qy_invites enable row level security;
revoke all on public.qy_invites from anon, authenticated;
alter table public.qy_ledgers add column if not exists status text not null default 'active';  -- active | pending | declined
alter table public.qy_ledgers add column if not exists invite_id uuid references public.qy_invites(id) on delete set null;
create index if not exists qy_ledgers_invite on public.qy_ledgers(invite_id, status);
-- v5: settling needs the other side's confirmation; undone entries stay visible in the history
alter table public.qy_ledgers add column if not exists settle_by char(1);
alter table public.qy_ledgers add column if not exists settle_at timestamptz;
alter table public.qy_ledgers add column if not exists settle_snapshot jsonb;
alter table public.qy_entries add column if not exists deleted_at timestamptz;
-- v6: a shared link belongs to the first phone that opens it (each phone sends a private id)
alter table public.qy_ledgers add column if not exists a_device text;
alter table public.qy_ledgers add column if not exists b_device text;

create index if not exists qy_entries_ledger on public.qy_entries(ledger_id, created_at desc);

alter table public.qy_ledgers enable row level security;
alter table public.qy_entries enable row level security;
revoke all on public.qy_ledgers, public.qy_entries from anon, authenticated;

-- old function signatures (replaced below)
drop function if exists public.qy_add(text, numeric, text);
drop function if exists public.qy_dispute(text, uuid);

-- helpers ---------------------------------------------------------------

-- 40 random hex characters (built-in, no extension needed)
create or replace function public._qy_token() returns text
language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
$$;

create or replace function public._qy_clean(p text, p_max int) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), p_max);
$$;

create or replace function public._qy_cur_ok(p text) returns boolean
language sql immutable as $$
  select p in ('USD','LBP','YER','SAR','AED','EUR','EGP');
$$;

-- the private id of the phone making this request (sent by the app as a header)
create or replace function public._qy_device() returns text
language sql stable as $$
  select nullif(left(coalesce(current_setting('request.headers', true)::json->>'x-qy-device', ''), 64), '');
$$;

-- phone lock for the shared side of a tab: the first phone to use the link owns it.
-- The tab creator's own phone never claims it (opening your own link by mistake is harmless).
create or replace function public._qy_guard(p_token text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare dev text := _qy_device(); l qy_ledgers;
begin
  select * into l from qy_ledgers where b_token = p_token;
  if not found then return; end if;                       -- creator side, or unknown token
  if l.b_device is null then
    if dev is not null and dev is distinct from l.a_device then
      update qy_ledgers set b_device = dev where id = l.id;
    end if;
    return;
  end if;
  if dev is distinct from l.b_device and dev is distinct from l.a_device then
    raise exception 'locked';
  end if;
end $$;

-- non-zero balance per currency, from one side's point of view: {"YER": 3000, "USD": -20}
create or replace function public._qy_balances(p_lid uuid, p_cur text, p_sg int) returns json
language sql stable as $$
  select coalesce(json_object_agg(c, b), '{}'::json) from (
    select coalesce(currency, p_cur) as c, sum(amount) * p_sg as b
    from public.qy_entries where ledger_id = p_lid and not deleted
    group by 1 having sum(amount) <> 0) x;
$$;

-- the view of a tab from one person's side
create or replace function public.qy_get(p_token text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1); sg int;
begin
  begin
    perform _qy_guard(p_token);
  exception when raise_exception then
    if sqlerrm = 'locked' then
      return json_build_object('locked', true, 'friend', (select a_name from qy_ledgers where b_token = p_token));
    end if;
    raise;
  end;
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then return null; end if;
  s  := case when l.a_token = p_token then 'a' else 'b' end;
  sg := case when s = 'a' then 1 else -1 end;
  return json_build_object(
    'ledger_id',  l.id,
    'side',       s,
    'me',         case when s = 'a' then l.a_name else l.b_name end,
    'friend',     case when s = 'a' then l.b_name else l.a_name end,
    'currency',   l.currency,
    'created_at', l.created_at,
    'updated_at', l.updated_at,
    'share_token', case when s = 'a' then l.b_token else null end,
    'status',     l.status,
    'link_locked', case when s = 'a' then l.b_device is not null else null end,
    'settle_request', case when l.settle_by is null then null else json_build_object(
                        'by_me', l.settle_by = s, 'at', l.settle_at,
                        'balances', (select coalesce(json_object_agg(x.key, x.value::numeric * sg), '{}'::json)
                                     from jsonb_each_text(l.settle_snapshot) x)) end,
    'balance',    coalesce((select sum(amount) from qy_entries
                            where ledger_id = l.id and not deleted
                              and coalesce(currency, l.currency) = l.currency), 0) * sg,
    'balances',   _qy_balances(l.id, l.currency, sg),
    'entries',    coalesce((select json_agg(json_build_object(
                      'id', e.id, 'amount', e.amount * sg, 'note', e.note,
                      'currency', coalesce(e.currency, l.currency),
                      'mine', e.by_side = s, 'kind', e.kind,
                      'disputed', e.disputed, 'dispute_reason', e.dispute_reason,
                      'group_id', e.group_id, 'split_total', e.split_total, 'split_count', e.split_count,
                      'deleted', e.deleted, 'deleted_at', e.deleted_at,
                      'created_at', e.created_at)
                    order by e.created_at desc)
                  from qy_entries e where e.ledger_id = l.id), '[]'::json)
  );
end $$;

create or replace function public.qy_summaries(p_tokens text[]) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(array_length(p_tokens, 1), 0) > 300 then raise exception 'too many'; end if;
  return coalesce((
    select json_agg(json_build_object(
      'token', t.tok, 'ledger_id', l.id,
      'side', case when l.a_token = t.tok then 'a' else 'b' end,
      'me', case when l.a_token = t.tok then l.a_name else l.b_name end,
      'friend', case when l.a_token = t.tok then l.b_name else l.a_name end,
      'currency', l.currency, 'updated_at', l.updated_at, 'status', l.status,
      'settle', case when l.settle_by is null then null
                     when l.settle_by = case when l.a_token = t.tok then 'a' else 'b' end then 'mine' else 'theirs' end,
      'locked', l.b_token = t.tok and l.b_device is not null and _qy_device() is distinct from l.b_device and _qy_device() is distinct from l.a_device,
      'balances', case when l.b_token = t.tok and l.b_device is not null and _qy_device() is distinct from l.b_device and _qy_device() is distinct from l.a_device
                       then null else _qy_balances(l.id, l.currency, case when l.a_token = t.tok then 1 else -1 end) end))
    from unnest(p_tokens) as t(tok)
    join qy_ledgers l on l.a_token = t.tok or l.b_token = t.tok), '[]'::json);
end $$;

create or replace function public.qy_create(p_my_name text, p_friend_name text, p_currency text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare me text := _qy_clean(p_my_name, 40);
        fr text := _qy_clean(p_friend_name, 40);
        ta text := _qy_token(); tb text := _qy_token();
begin
  if me = '' or fr = '' then raise exception 'name required'; end if;
  if not _qy_cur_ok(p_currency) then raise exception 'bad currency'; end if;
  insert into qy_ledgers(currency, a_name, b_name, a_token, b_token, a_device)
  values (p_currency, me, fr, ta, tb, _qy_device());
  return json_build_object('token', ta, 'share_token', tb);
end $$;

create or replace function public.qy_add(p_token text, p_amount numeric, p_note text, p_currency text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1); cur text;
begin
  perform _qy_guard(p_token);
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  cur := coalesce(p_currency, l.currency);
  if not _qy_cur_ok(cur) then raise exception 'bad currency'; end if;
  if p_amount is null or round(p_amount, 2) = 0 or abs(p_amount) > 1e12 then
    raise exception 'bad amount';
  end if;
  insert into qy_entries(ledger_id, amount, note, by_side, currency)
  values (l.id, round(p_amount, 2) * case when s = 'a' then 1 else -1 end,
          _qy_clean(p_note, 140), s, cur);
  update qy_ledgers set updated_at = now(), currency = cur, settle_by = null, settle_at = null, settle_snapshot = null where id = l.id;
  return qy_get(p_token);
end $$;

-- settling needs both people: one asks, the other confirms.
-- The request remembers the balances it was made for; if the tab changes before the
-- other person answers, the request is dropped (nobody confirms numbers they didn't see).
create or replace function public.qy_settle(p_token text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1); snap jsonb;
begin
  perform _qy_guard(p_token);
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  snap := _qy_balances(l.id, l.currency, 1)::jsonb;
  if snap = '{}'::jsonb then return qy_get(p_token); end if;
  if l.settle_by is not null and l.settle_by <> s then
    return qy_settle_answer(p_token, true);          -- both asked: that's a yes
  end if;
  update qy_ledgers set settle_by = s, settle_at = now(), settle_snapshot = snap, updated_at = now() where id = l.id;
  return qy_get(p_token);
end $$;

-- the other person confirms (true) or declines (false); the asker can only cancel (false)
create or replace function public.qy_settle_answer(p_token text, p_accept boolean)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1); cur jsonb;
begin
  perform _qy_guard(p_token);
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  if l.settle_by is null then return qy_get(p_token); end if;
  if l.settle_by = s and p_accept then return qy_get(p_token); end if;   -- can't confirm your own request
  if not p_accept then
    update qy_ledgers set settle_by = null, settle_at = null, settle_snapshot = null, updated_at = now() where id = l.id;
    return qy_get(p_token);
  end if;
  cur := _qy_balances(l.id, l.currency, 1)::jsonb;
  update qy_ledgers set settle_by = null, settle_at = null, settle_snapshot = null, updated_at = now() where id = l.id;
  if cur is distinct from l.settle_snapshot then
    return json_build_object('changed', true);
  end if;
  insert into qy_entries(ledger_id, amount, by_side, kind, currency)
  select l.id, -(x.value::numeric), l.settle_by, 'settle', x.key from jsonb_each_text(cur) x;
  return qy_get(p_token);
end $$;

-- only the person who added an entry can undo it, and nothing from before a confirmed settle
create or replace function public.qy_remove(p_token text, p_id uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  perform _qy_guard(p_token);
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  -- a confirmed settle can't be undone by one side; undone entries stay visible, crossed out
  update qy_entries e set deleted = true, deleted_at = now()
   where e.id = p_id and e.ledger_id = l.id and e.by_side = s and e.kind = 'entry' and not e.deleted
     and not exists (select 1 from qy_entries z where z.ledger_id = e.ledger_id and z.kind = 'settle' and z.created_at > e.created_at);
  if found then
    update qy_ledgers set updated_at = now(), settle_by = null, settle_at = null, settle_snapshot = null where id = l.id;
  end if;
  return qy_get(p_token);
end $$;

-- only the other person can flag an entry as "not right", with an optional short reason
create or replace function public.qy_dispute(p_token text, p_id uuid, p_reason text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  perform _qy_guard(p_token);
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  update qy_entries e
     set disputed = not e.disputed,
         dispute_reason = case when e.disputed then '' else _qy_clean(p_reason, 60) end
   where e.id = p_id and e.ledger_id = l.id and e.by_side <> s and e.kind = 'entry' and not e.deleted
     and not exists (select 1 from qy_entries z where z.ledger_id = e.ledger_id and z.kind = 'settle' and z.created_at > e.created_at);
  update qy_ledgers set updated_at = now() where id = l.id;
  return qy_get(p_token);
end $$;

-- one shared expense split across several tabs, all or nothing.
-- p_items: [{"token": "...", "amount": 3000}, ...] — each amount is what that friend owes me
create or replace function public.qy_split(p_items json, p_note text, p_currency text, p_total numeric, p_count int)
returns json language plpgsql volatile security definer set search_path = public as $$
declare g uuid := gen_random_uuid(); it json; l qy_ledgers; s char(1); amt numeric; eid uuid; res json[] := '{}';
begin
  if not _qy_cur_ok(p_currency) then raise exception 'bad currency'; end if;
  if json_array_length(p_items) not between 1 and 60 or p_count not between 2 and 61 then raise exception 'bad size'; end if;
  if p_total is null or p_total <= 0 or p_total > 1e12 then raise exception 'bad total'; end if;
  for it in select * from json_array_elements(p_items) loop
    perform _qy_guard(it->>'token');
    select * into l from qy_ledgers where a_token = it->>'token' or b_token = it->>'token';
    if not found then raise exception 'not found'; end if;
    if l.status <> 'active' then raise exception 'not active'; end if;
    s := case when l.a_token = it->>'token' then 'a' else 'b' end;
    amt := round((it->>'amount')::numeric, 2);
    if amt is null or amt <= 0 or amt > p_total then raise exception 'bad amount'; end if;
    insert into qy_entries(ledger_id, amount, note, by_side, currency, group_id, split_total, split_count)
    values (l.id, amt * case when s = 'a' then 1 else -1 end, _qy_clean(p_note, 140), s, p_currency, g, round(p_total, 2), p_count)
    returning id into eid;
    update qy_ledgers set updated_at = now(), settle_by = null, settle_at = null, settle_snapshot = null where id = l.id;
    res := res || json_build_object('token', it->>'token', 'id', eid, 'amount', amt);
  end loop;
  return json_build_object('group_id', g, 'items', array_to_json(res));
end $$;

-- ---------- public invite link ----------
create or replace function public.qy_invite_create(p_name text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare n text := _qy_clean(p_name, 40); c text := substr(_qy_token(), 1, 16); k text := _qy_token();
begin
  if n = '' then raise exception 'name required'; end if;
  insert into qy_invites(owner_name, code, owner_key) values (n, c, k);
  return json_build_object('code', c, 'key', k, 'enabled', true, 'owner', n);
end $$;

-- what a visitor sees before joining: only the owner's name
create or replace function public.qy_invite_info(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('owner', owner_name, 'enabled', enabled) from qy_invites where code = p_code;
$$;

-- a visitor asks for a tab; it waits for the owner's approval. Rate-limited per link.
create or replace function public.qy_join(p_code text, p_name text, p_currency text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare i qy_invites; n text := _qy_clean(p_name, 40); tb text := _qy_token(); waiting int; recent int;
begin
  select * into i from qy_invites where code = p_code;
  if not found or not i.enabled then raise exception 'invite closed'; end if;
  if n = '' then raise exception 'name required'; end if;
  if not _qy_cur_ok(p_currency) then raise exception 'bad currency'; end if;
  select count(*) into waiting from qy_ledgers where invite_id = i.id and status = 'pending';
  if waiting >= 20 then raise exception 'too many requests'; end if;
  select count(*) into recent from qy_ledgers where invite_id = i.id and created_at > now() - interval '10 minutes';
  if recent >= 5 then raise exception 'slow down'; end if;
  insert into qy_ledgers(currency, a_name, b_name, a_token, b_token, status, invite_id, b_device)
  values (p_currency, i.owner_name, n, _qy_token(), tb, 'pending', i.id, _qy_device());
  return json_build_object('token', tb);
end $$;

create or replace function public.qy_invite_requests(p_key text) returns json
language plpgsql stable security definer set search_path = public as $$
declare i qy_invites;
begin
  select * into i from qy_invites where owner_key = p_key;
  if not found then return null; end if;
  return json_build_object('code', i.code, 'enabled', i.enabled, 'owner', i.owner_name,
    'pending', coalesce((select json_agg(json_build_object('ledger_id', l.id, 'name', l.b_name, 'created_at', l.created_at)
                                        order by l.created_at)
                         from qy_ledgers l where l.invite_id = i.id and l.status = 'pending'), '[]'::json));
end $$;

-- accept or decline one request; p_ledger null + decline = decline all waiting requests
create or replace function public.qy_invite_decide(p_key text, p_ledger uuid, p_accept boolean) returns json
language plpgsql volatile security definer set search_path = public as $$
declare i qy_invites; l qy_ledgers;
begin
  select * into i from qy_invites where owner_key = p_key;
  if not found then raise exception 'not found'; end if;
  if p_ledger is null and not p_accept then
    update qy_ledgers set status = 'declined', updated_at = now() where invite_id = i.id and status = 'pending';
    return json_build_object('declined', true);
  end if;
  select * into l from qy_ledgers where id = p_ledger and invite_id = i.id and status = 'pending';
  if not found then return null; end if;
  if p_accept then
    update qy_ledgers set status = 'active', updated_at = now(), a_device = coalesce(a_device, _qy_device()) where id = l.id;
    return json_build_object('token', l.a_token);
  end if;
  update qy_ledgers set status = 'declined', updated_at = now() where id = l.id;
  return json_build_object('declined', true);
end $$;

-- switch the link on/off, replace it with a new one (old link stops working), or rename
create or replace function public.qy_invite_set(p_key text, p_enabled boolean, p_reset boolean, p_name text default null) returns json
language plpgsql volatile security definer set search_path = public as $$
declare i qy_invites;
begin
  update qy_invites set
    enabled = coalesce(p_enabled, enabled),
    code = case when p_reset then substr(_qy_token(), 1, 16) else code end,
    owner_name = coalesce(nullif(_qy_clean(p_name, 40), ''), owner_name)
  where owner_key = p_key returning * into i;
  if not found then return null; end if;
  return json_build_object('code', i.code, 'enabled', i.enabled, 'owner', i.owner_name);
end $$;

-- creator replaces the friend's link (new phone, or the link reached the wrong person).
-- The old link stops working; the next phone to open the new one owns it.
create or replace function public.qy_new_link(p_token text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare nb text := _qy_token();
begin
  update qy_ledgers set b_token = nb, b_device = null, updated_at = now() where a_token = p_token;
  if not found then raise exception 'not found'; end if;
  return json_build_object('share_token', nb);
end $$;

create or replace function public.qy_rename(p_token text, p_name text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare n text := _qy_clean(p_name, 40);
begin
  perform _qy_guard(p_token);
  if n = '' then raise exception 'name required'; end if;
  update qy_ledgers set a_name = n, updated_at = now() where a_token = p_token;
  update qy_ledgers set b_name = n, updated_at = now() where b_token = p_token;
  return qy_get(p_token);
end $$;

revoke execute on function public._qy_token(), public._qy_balances(uuid, text, int), public._qy_guard(text), public._qy_device()
  from public, anon, authenticated;
grant execute on function public.qy_get(text), public.qy_summaries(text[]),
  public.qy_create(text, text, text), public.qy_add(text, numeric, text, text),
  public.qy_settle(text), public.qy_settle_answer(text, boolean), public.qy_remove(text, uuid), public.qy_dispute(text, uuid, text),
  public.qy_rename(text, text), public.qy_split(json, text, text, numeric, int),
  public.qy_invite_create(text), public.qy_invite_info(text), public.qy_join(text, text, text),
  public.qy_invite_requests(text), public.qy_invite_decide(text, uuid, boolean),
  public.qy_invite_set(text, boolean, boolean, text), public.qy_new_link(text) to anon, authenticated;

-- make the API see the new functions right away
notify pgrst, 'reload schema';
