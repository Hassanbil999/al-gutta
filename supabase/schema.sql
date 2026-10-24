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
language plpgsql stable security definer set search_path = public as $$
declare l qy_ledgers; s char(1); sg int;
begin
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
                      'created_at', e.created_at)
                    order by e.created_at desc)
                  from qy_entries e where e.ledger_id = l.id and not e.deleted), '[]'::json)
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
      'balances', _qy_balances(l.id, l.currency, case when l.a_token = t.tok then 1 else -1 end)))
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
  insert into qy_ledgers(currency, a_name, b_name, a_token, b_token)
  values (p_currency, me, fr, ta, tb);
  return json_build_object('token', ta, 'share_token', tb);
end $$;

create or replace function public.qy_add(p_token text, p_amount numeric, p_note text, p_currency text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1); cur text;
begin
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
  update qy_ledgers set updated_at = now(), currency = cur where id = l.id;
  return qy_get(p_token);
end $$;

-- settles every currency back to zero
create or replace function public.qy_settle(p_token text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  insert into qy_entries(ledger_id, amount, by_side, kind, currency)
  select l.id, -sum(amount), s, 'settle', coalesce(currency, l.currency)
    from qy_entries where ledger_id = l.id and not deleted
   group by coalesce(currency, l.currency) having sum(amount) <> 0;
  update qy_ledgers set updated_at = now() where id = l.id;
  return qy_get(p_token);
end $$;

-- only the person who added an entry can undo it
create or replace function public.qy_remove(p_token text, p_id uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  update qy_entries set deleted = true where id = p_id and ledger_id = l.id and by_side = s;
  update qy_ledgers set updated_at = now() where id = l.id;
  return qy_get(p_token);
end $$;

-- only the other person can flag an entry as "not right", with an optional short reason
create or replace function public.qy_dispute(p_token text, p_id uuid, p_reason text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if l.status <> 'active' then raise exception 'not active'; end if;
  update qy_entries
     set disputed = not disputed,
         dispute_reason = case when disputed then '' else _qy_clean(p_reason, 60) end
   where id = p_id and ledger_id = l.id and by_side <> s and kind = 'entry';
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
    select * into l from qy_ledgers where a_token = it->>'token' or b_token = it->>'token';
    if not found then raise exception 'not found'; end if;
    if l.status <> 'active' then raise exception 'not active'; end if;
    s := case when l.a_token = it->>'token' then 'a' else 'b' end;
    amt := round((it->>'amount')::numeric, 2);
    if amt is null or amt <= 0 or amt > p_total then raise exception 'bad amount'; end if;
    insert into qy_entries(ledger_id, amount, note, by_side, currency, group_id, split_total, split_count)
    values (l.id, amt * case when s = 'a' then 1 else -1 end, _qy_clean(p_note, 140), s, p_currency, g, round(p_total, 2), p_count)
    returning id into eid;
    update qy_ledgers set updated_at = now() where id = l.id;
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
  insert into qy_ledgers(currency, a_name, b_name, a_token, b_token, status, invite_id)
  values (p_currency, i.owner_name, n, _qy_token(), tb, 'pending', i.id);
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
    update qy_ledgers set status = 'active', updated_at = now() where id = l.id;
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

create or replace function public.qy_rename(p_token text, p_name text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare n text := _qy_clean(p_name, 40);
begin
  if n = '' then raise exception 'name required'; end if;
  update qy_ledgers set a_name = n, updated_at = now() where a_token = p_token;
  update qy_ledgers set b_name = n, updated_at = now() where b_token = p_token;
  return qy_get(p_token);
end $$;

revoke execute on function public._qy_token(), public._qy_balances(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.qy_get(text), public.qy_summaries(text[]),
  public.qy_create(text, text, text), public.qy_add(text, numeric, text, text),
  public.qy_settle(text), public.qy_remove(text, uuid), public.qy_dispute(text, uuid, text),
  public.qy_rename(text, text), public.qy_split(json, text, text, numeric, int),
  public.qy_invite_create(text), public.qy_invite_info(text), public.qy_join(text, text, text),
  public.qy_invite_requests(text), public.qy_invite_decide(text, uuid, boolean),
  public.qy_invite_set(text, boolean, boolean, text) to anon, authenticated;

-- make the API see the new functions right away
notify pgrst, 'reload schema';
