-- Append-only ledger of match changes. The "matches" the site shows is a view over the ledger
-- up to a movable head pointer, so any change can be rolled back and fast-forwarded without losing history.
-- Nothing here deletes data: the old table is renamed, and "remove" is just another ledger entry.

alter table public.matches rename to matches_legacy;
alter index if exists public.matches_dedupe rename to matches_legacy_dedupe;

create table public.match_events (
  seq        bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  action     text not null check (action in ('add', 'remove')),
  match_id   text not null,
  data       jsonb not null,           -- the full match (for 'remove', the match as it was when removed)
  by_email   text,
  note       text,
  superseded boolean not null default false   -- true once a new change was made after rolling back past this entry
);
create index match_events_match on public.match_events (match_id);

create table public.ledger_head (
  id  int primary key default 1 check (id = 1),
  seq bigint not null default 0            -- state shown on the site = all live entries with seq <= this
);
insert into public.ledger_head values (1, 0);

create table public.ledger_audit (          -- log of rollbacks / fast-forwards
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  by_email text,
  action   text not null,
  from_seq bigint not null,
  to_seq   bigint not null
);

alter table public.match_events enable row level security;
alter table public.ledger_head  enable row level security;
alter table public.ledger_audit enable row level security;
create policy "public read events" on public.match_events for select using (true);
create policy "public read head"   on public.ledger_head  for select using (true);
create policy "public read audit"  on public.ledger_audit for select using (true);

create view public.matches with (security_invoker = true) as
select e.match_id as id, (e.data ->> 'date')::date as date, e.data ->> 'map' as map, e.data as data, e.seq as seq
from public.match_events e
where e.action = 'add' and not e.superseded
  and e.seq <= (select seq from public.ledger_head where id = 1)
  and not exists (
    select 1 from public.match_events r
    where r.action = 'remove' and r.match_id = e.match_id and not r.superseded
      and r.seq > e.seq and r.seq <= (select seq from public.ledger_head where id = 1));
grant select on public.matches to anon, authenticated;

-- All writes go through these functions, called by the ingest-match edge function with the service role.
-- Each locks the head row first, so concurrent / double-clicked requests are applied one at a time.
create function public.ledger_add(m jsonb, by_email text default null, note text default null) returns jsonb
language plpgsql as $$
declare h bigint; s bigint; mid text;
begin
  select seq into h from public.ledger_head where id = 1 for update;
  mid := coalesce(nullif(m ->> 'id', ''), (m ->> 'date') || '-' || lower(m ->> 'map') || '-' || (m -> 'score' ->> 0) || '-' || (m -> 'score' ->> 1));
  m := jsonb_set(m, '{id}', to_jsonb(mid));
  if exists (select 1 from public.matches x where x.id = mid
             or (x.date = (m ->> 'date')::date and lower(x.map) = lower(m ->> 'map') and x.data -> 'score' = m -> 'score')) then
    return jsonb_build_object('ok', false, 'error', 'already on the site');
  end if;
  update public.match_events set superseded = true where seq > h and not superseded;
  insert into public.match_events (action, match_id, data, by_email, note) values ('add', mid, m, by_email, note) returning seq into s;
  update public.ledger_head set seq = s where id = 1;
  return jsonb_build_object('ok', true, 'id', mid, 'seq', s);
end $$;

create function public.ledger_remove(mid text, by_email text default null, note text default null) returns jsonb
language plpgsql as $$
declare h bigint; s bigint; d jsonb;
begin
  select seq into h from public.ledger_head where id = 1 for update;
  select x.data into d from public.matches x where x.id = mid;
  if d is null then return jsonb_build_object('ok', false, 'error', 'match not found'); end if;
  update public.match_events set superseded = true where seq > h and not superseded;
  insert into public.match_events (action, match_id, data, by_email, note) values ('remove', mid, d, by_email, note) returning seq into s;
  update public.ledger_head set seq = s where id = 1;
  return jsonb_build_object('ok', true, 'seq', s);
end $$;

create function public.ledger_move(target bigint, by_email text default null) returns jsonb
language plpgsql as $$
declare h bigint;
begin
  select seq into h from public.ledger_head where id = 1 for update;
  if target <> 0 and not exists (select 1 from public.match_events where seq = target and not superseded) then
    return jsonb_build_object('ok', false, 'error', 'no such step');
  end if;
  if target = h then return jsonb_build_object('ok', true, 'seq', h); end if;
  insert into public.ledger_audit (by_email, action, from_seq, to_seq)
    values (by_email, case when target < h then 'rollback' else 'forward' end, h, target);
  update public.ledger_head set seq = target where id = 1;
  return jsonb_build_object('ok', true, 'seq', target);
end $$;

revoke all on function public.ledger_add(jsonb, text, text), public.ledger_remove(text, text, text), public.ledger_move(bigint, text) from public, anon, authenticated;
grant execute on function public.ledger_add(jsonb, text, text), public.ledger_remove(text, text, text), public.ledger_move(bigint, text) to service_role;

-- Seed the ledger from the old table, keeping original timestamps and uploader.
insert into public.match_events (at, action, match_id, data, by_email, note)
select l.created_at, 'add', l.id, l.data,
       coalesce((select u.email from auth.users u where u.id = l.uploaded_by), 'seed'),
       case when l.uploaded_by is null then 'initial import' else 'imported from the pre-ledger table' end
from public.matches_legacy l order by l.created_at, l.id;
update public.ledger_head set seq = (select coalesce(max(seq), 0) from public.match_events) where id = 1;
