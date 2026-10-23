-- القطة ياعبدو — database schema
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to re-run.
--
-- Security model: there are no user accounts. Each tab has two secret tokens,
-- one per person. The tables are locked (RLS on, no policies), so the only way
-- in is through the functions below, and each function needs a valid token.

create extension if not exists pgcrypto;

create table if not exists public.qy_ledgers (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  currency    text not null default 'YER',
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
create index if not exists qy_entries_ledger on public.qy_entries(ledger_id, created_at desc);

alter table public.qy_ledgers enable row level security;
alter table public.qy_entries enable row level security;
revoke all on public.qy_ledgers, public.qy_entries from anon, authenticated;

-- helpers ---------------------------------------------------------------

create or replace function public._qy_token() returns text
language sql volatile as $$
  select rtrim(translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'), '=');
$$;

create or replace function public._qy_clean(p text, p_max int) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), p_max);
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
    'balance',    coalesce((select sum(amount) from qy_entries
                            where ledger_id = l.id and not deleted), 0) * sg,
    'entries',    coalesce((select json_agg(json_build_object(
                      'id', e.id, 'amount', e.amount * sg, 'note', e.note,
                      'mine', e.by_side = s, 'kind', e.kind,
                      'disputed', e.disputed, 'created_at', e.created_at)
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
      'currency', l.currency, 'updated_at', l.updated_at,
      'balance', coalesce((select sum(amount) from qy_entries e
                           where e.ledger_id = l.id and not e.deleted), 0)
                 * case when l.a_token = t.tok then 1 else -1 end))
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
  if p_currency not in ('YER','SAR','USD','AED','EGP','EUR') then raise exception 'bad currency'; end if;
  insert into qy_ledgers(currency, a_name, b_name, a_token, b_token)
  values (p_currency, me, fr, ta, tb);
  return json_build_object('token', ta, 'share_token', tb);
end $$;

create or replace function public.qy_add(p_token text, p_amount numeric, p_note text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  if p_amount is null or round(p_amount, 2) = 0 or abs(p_amount) > 1e12 then
    raise exception 'bad amount';
  end if;
  insert into qy_entries(ledger_id, amount, note, by_side)
  values (l.id, round(p_amount, 2) * case when s = 'a' then 1 else -1 end,
          _qy_clean(p_note, 140), s);
  update qy_ledgers set updated_at = now() where id = l.id;
  return qy_get(p_token);
end $$;

create or replace function public.qy_settle(p_token text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1); bal numeric;
begin
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  select coalesce(sum(amount), 0) into bal from qy_entries where ledger_id = l.id and not deleted;
  if bal <> 0 then
    insert into qy_entries(ledger_id, amount, by_side, kind) values (l.id, -bal, s, 'settle');
    update qy_ledgers set updated_at = now() where id = l.id;
  end if;
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
  update qy_entries set deleted = true where id = p_id and ledger_id = l.id and by_side = s;
  update qy_ledgers set updated_at = now() where id = l.id;
  return qy_get(p_token);
end $$;

-- only the other person can flag an entry as "not right"
create or replace function public.qy_dispute(p_token text, p_id uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
declare l qy_ledgers; s char(1);
begin
  select * into l from qy_ledgers where a_token = p_token or b_token = p_token;
  if not found then raise exception 'not found'; end if;
  s := case when l.a_token = p_token then 'a' else 'b' end;
  update qy_entries set disputed = not disputed
   where id = p_id and ledger_id = l.id and by_side <> s and kind = 'entry';
  update qy_ledgers set updated_at = now() where id = l.id;
  return qy_get(p_token);
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

revoke execute on function public._qy_token() from public, anon, authenticated;
grant execute on function public.qy_get(text), public.qy_summaries(text[]),
  public.qy_create(text, text, text), public.qy_add(text, numeric, text),
  public.qy_settle(text), public.qy_remove(text, uuid), public.qy_dispute(text, uuid),
  public.qy_rename(text, text) to anon, authenticated;

-- make the API see the new functions right away
notify pgrst, 'reload schema';
