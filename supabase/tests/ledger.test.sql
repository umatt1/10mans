-- Ledger tests. Paste into the Supabase SQL editor and run.
-- Everything happens inside ONE do-block that always ends by raising an exception, so Postgres rolls the whole
-- block back and nothing here can touch real data. Read the result:
--   "LEDGER TESTS PASSED ..."  -> all assertions held
--   anything else (e.g. "add t-one") -> the assertion with that message failed

do $$
declare
  r jsonb; c0 int; s1 bigint; s2 bigint; s3 bigint; s4 bigint;
  m1 jsonb := '{"id":"t-one","date":"2099-01-01","map":"TestMap","score":[13,1]}';
  m2 jsonb := '{"id":"t-two","date":"2099-01-02","map":"TestMap","score":[13,2]}';
  m3 jsonb := '{"id":"t-three","date":"2099-01-03","map":"TestMap","score":[13,3]}';
  visible int;
  n_updated int;
begin
  select count(*) into c0 from public.matches;

  r := public.ledger_add(m1, 't'); assert (r->>'ok')::boolean, 'add t-one'; s1 := (r->>'seq')::bigint;
  select count(*) into visible from public.matches; assert visible = c0 + 1, 'one more match visible after add';

  r := public.ledger_add(m1, 't'); assert not (r->>'ok')::boolean and r->>'error' = 'already on the site', 'same id is refused';
  r := public.ledger_add('{"id":"other-id","date":"2099-01-01","map":"testmap","score":[13,1]}', 't');
  assert not (r->>'ok')::boolean, 'same date+map+score is refused even with a new id and different case';
  select count(*) into visible from public.matches; assert visible = c0 + 1, 'duplicates added nothing';

  r := public.ledger_add(m2, 't'); assert (r->>'ok')::boolean, 'add t-two'; s2 := (r->>'seq')::bigint;
  assert s2 > s1, 'sequence increases';
  select count(*) into visible from public.matches; assert visible = c0 + 2, 'two added';

  -- roll back, then fast-forward
  r := public.ledger_move(s1, 't'); assert (r->>'ok')::boolean, 'rollback to t-one';
  select count(*) into visible from public.matches; assert visible = c0 + 1, 'rollback hides t-two';
  assert not exists (select 1 from public.matches where id = 't-two'), 't-two hidden after rollback';
  r := public.ledger_move(s2, 't'); assert (r->>'ok')::boolean, 'fast-forward to t-two';
  select count(*) into visible from public.matches; assert visible = c0 + 2, 'fast-forward shows t-two again';
  assert (select count(*) from public.ledger_audit where by_email = 't') = 2, 'both moves are audited';

  -- a new change while rolled back discards the undone entries
  r := public.ledger_move(s1, 't');
  r := public.ledger_add(m3, 't'); assert (r->>'ok')::boolean, 'add t-three after rollback'; s3 := (r->>'seq')::bigint;
  assert (select superseded from public.match_events where seq = s2), 't-two entry was superseded';
  r := public.ledger_move(s2, 't'); assert not (r->>'ok')::boolean and r->>'error' = 'no such step', 'cannot fast-forward onto a superseded entry';
  assert exists (select 1 from public.matches where id = 't-three') and not exists (select 1 from public.matches where id = 't-two'), 'branch kept t-three, dropped t-two';

  -- remove is reversible
  r := public.ledger_remove('t-one', 't'); assert (r->>'ok')::boolean, 'remove t-one'; s4 := (r->>'seq')::bigint;
  assert not exists (select 1 from public.matches where id = 't-one'), 't-one gone from the view';
  assert exists (select 1 from public.match_events where match_id = 't-one' and action = 'add'), 'its add entry is still in the ledger';
  r := public.ledger_move(s3, 't'); assert exists (select 1 from public.matches where id = 't-one'), 'rolling back past the remove brings it back';
  r := public.ledger_move(s4, 't'); assert not exists (select 1 from public.matches where id = 't-one'), 'fast-forward removes it again';
  r := public.ledger_remove('does-not-exist', 't'); assert not (r->>'ok')::boolean, 'removing an unknown match is refused';

  -- a removed match can be added back
  r := public.ledger_add(m1, 't'); assert (r->>'ok')::boolean, 're-add after remove';
  assert exists (select 1 from public.matches where id = 't-one'), 'visible again after re-add';

  -- the very start
  r := public.ledger_move(0, 't'); select count(*) into visible from public.matches; assert visible = 0, 'seq 0 is the empty start';

  -- who may call what
  assert not has_function_privilege('anon', 'public.ledger_add(jsonb,text,text)', 'execute'), 'anon cannot add';
  assert not has_function_privilege('authenticated', 'public.ledger_remove(text,text,text)', 'execute'), 'signed-in users cannot call remove directly';
  assert not has_function_privilege('anon', 'public.ledger_move(bigint,text)', 'execute'), 'anon cannot move the head';
  assert has_function_privilege('service_role', 'public.ledger_add(jsonb,text,text)', 'execute'), 'the edge function (service role) can add';
  -- Supabase grants table privileges to anon/authenticated by default; row-level security is what blocks writes.
  -- So test the behaviour as those roles rather than the grants.
  begin
    set local role anon;
    insert into public.match_events (action, match_id, data) values ('add', 'hack', '{}');
    reset role;
    assert false, 'anon was able to insert a ledger row';
  exception when insufficient_privilege then
    reset role;  -- expected: row-level security refused the insert
  end;
  set local role authenticated;
  update public.ledger_head set seq = 999;
  get diagnostics n_updated = row_count;
  reset role;
  assert n_updated = 0, 'a signed-in user moved the ledger head by hand';
  set local role anon;
  select count(*) into visible from public.matches;
  reset role;
  assert visible = 0, 'anyone can read the view (still at the empty start)';

  raise exception 'LEDGER TESTS PASSED (all changes rolled back)';
end $$;
