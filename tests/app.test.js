const test = require("node:test"), assert = require("node:assert/strict");
const {load} = require("./harness");

test("agg weights K/D, ADR and HS% over totals, not per-map averages", async () => {
  const {run} = await load();
  const g = run(`agg([{k:20,d:10,a:5,hs:50,rounds:20,dmg:2000},{k:10,d:10,a:0,hs:20,rounds:20,dmg:1000}])`);
  assert.equal(g.kd, 1.5);
  assert.equal(g.adr, 75);
  assert.equal(g.hs, 40);
  assert.ok(Number.isFinite(g.rating));
});

test("sheet mode: 13 maps, stray 04-26 row folded into 04-25, no empty games", async () => {
  const {run} = await load();
  assert.equal(run("DB.games.length"), 13);
  assert.equal(run("DB.games.some(g => g.date === '2026-04-26')"), false);
  assert.equal(run("DB.games.find(g => g.date === '2026-04-25' && g.map === 'Ancient').rows.length"), 10);
  assert.equal(run("DB.games.filter(g => g.rows.length === 10).length"), 10);
});

test("Refrag demo scores attach to sheet games a day apart, matched by round count", async () => {
  const {run} = await load();
  assert.deepEqual(run("DB.games.find(g => g.date === '2026-04-11' && g.map === 'Mirage').score"), [13, 3]);
  assert.deepEqual(run("DB.games.find(g => g.date === '2026-04-11' && g.map === 'Overpass').score"), [13, 7]);
});

test("teams come from the first scoreboard and the series is 2:0", async () => {
  const {run} = await load();
  const s = run("DB.series['2026-10-17']");
  assert.deepEqual(s.wins, {A: 2, B: 0});
  assert.ok(s.A.includes("Will") && s.A.includes("Matt") && s.B.includes("Cristian"));
  assert.equal(run("DB.players.Matt.filter(r => r.date === '2026-10-17').every(r => r.win === true)"), true);
  assert.equal(run("DB.players.Cristian.filter(r => r.date === '2026-10-17').every(r => r.win === false)"), true);
});

test("Refrag mode only has the official scoreboards", async () => {
  const {run} = await load({src: "refrag"});
  assert.equal(run("DB.games.length"), 8);
  assert.equal(run("DB.rows.length"), 20);
  assert.ok(run("DB.rows.every(r => r.rating != null && r.kast != null)"));
  assert.equal(run("DB.pagg.Matt.n"), 2);
});

test("a locally added match shows up and survives the id/score duplicate check", async () => {
  const m = {id: "t1", date: "2026-11-01", map: "Nuke", score: [13, 9]};
  const {run} = await load({local: [m]});
  assert.equal(run("DB.games.some(g => g.date === '2026-11-01' && g.map === 'Nuke')"), true);
  assert.deepEqual(run(`validateMatch({date:'2026-11-01',map:'nuke',score:[13,9]})`), ["already on the site"]);
});

test("validateMatch accepts good files and explains bad ones", async () => {
  const {run} = await load();
  assert.deepEqual(run(`validateMatch({date:'2026-12-01',map:'Mirage',score:[13,2]})`), []);
  assert.ok(run(`validateMatch({date:'12/1/26',map:'',score:[1]})`).length >= 3);
  assert.ok(run(`validateMatch({date:'2026-12-01',map:'Mirage',score:[13,2],win:[{name:'a',k:1,d:1,a:1}]})`).includes("win and lose must both be present"));
  assert.ok(run(`validateMatch({id:'f8c854ca-4026-4371-bd01-775d3b888015',date:'2030-01-01',map:'X',score:[1,2]})`).includes("already on the site"));
});

test("pivot: counts add up and totals recompute from the group", async () => {
  const {run} = await load();
  const C = run(`(() => { location.hash = '#pivot?rows=map&val=maps'; return pivotCompute(pivotParams()); })()`);
  assert.equal(C.rkeys.reduce((t, k) => t + C.total[k], 0), run("DB.rows.length"));
  const kd = run(`(() => { location.hash = '#pivot?rows=player&val=kd'; const C = pivotCompute(pivotParams()); return C.total.Matt; })()`);
  assert.ok(Math.abs(kd - run("DB.pagg.Matt.kd")) < 1e-9);
});

test("CSV output escapes commas, quotes and newlines", async () => {
  const {run} = await load();
  assert.equal(run(`toCsv(['a','b'], [['x,y','he said "hi"'],['line\\nbreak','']])`), 'a,b\n"x,y","he said ""hi"""\n"line\nbreak",');
});

test("every view renders without throwing", async () => {
  const {run, el} = await load();
  for (const [name, call] of [["overview", "overview()"], ["days", "daysView()"], ["players", "playersView()"], ["maps", "mapsView()"],
      ["records", "recordsView()"], ["compare", "compareView('Matt','Will')"], ["pivot", "pivotView()"], ["contribute", "contributeView()"], ["player", "playerView('Matt')"]]) {
    run(call);
    assert.ok(el("#app").innerHTML.length > 200, `${name} rendered nothing`);
  }
  run("overview()");
  assert.match(el("#app").innerHTML, /Leaderboard/);
});

test("supabase mode reads matches and aliases through PostgREST", async () => {
  const seen = [];
  const {run} = await load({mode: "supabase", fetchImpl: (u, o, d) => { seen.push([u, o?.headers?.apikey]); return d(u, o); }});
  assert.equal(run("REF.matches.length"), 8);
  assert.equal(run("REF.aliases.OATH"), "Will");
  assert.ok(seen.some(([u, k]) => u.startsWith("https://x.supabase.co/rest/v1/matches") && k === "sb_publishable_test"));
});

test("double-clicking Publish sends exactly one request", async () => {
  const session = {token: "t", email: "x@y.z", exp: Date.now() + 3.6e6};
  const {run, click, posts} = await load({mode: "supabase", session});
  run(`PEND = [{name:'f.json', m:{id:'n1',date:'2026-12-01',map:'Nuke',score:[13,1]}, problems:[]}]`);
  click({act: "publish"});
  click({act: "publish"});
  click({act: "publish"});
  await new Promise(r => setTimeout(r, 150));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.action, "add");
  assert.equal(run("BUSY"), false);
  assert.equal(run("PEND.length"), 0);
});

test("Remove needs a second click to confirm, then sends one remove", async () => {
  const session = {token: "t", email: "x@y.z", exp: Date.now() + 3.6e6};
  const {click, posts} = await load({mode: "supabase", session});
  const btn = click({act: "rmremote", id: "demo-2026-01-16-inferno"});
  assert.equal(posts.length, 0, "first click only arms the button");
  assert.equal(btn.textContent, "Click again to confirm");
  click(btn.dataset, btn);
  click(btn.dataset, btn);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, {action: "remove", id: "demo-2026-01-16-inferno"});
});

test("history moves are sent as {action:'move', seq}", async () => {
  const session = {token: "t", email: "x@y.z", exp: Date.now() + 3.6e6};
  const {click, posts, run} = await load({mode: "supabase", session});
  const btn = click({act: "ledger", seq: "7"});
  click(btn.dataset, btn);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(posts.map(p => p.body), [{action: "move", seq: 7}]);
  void run;
});

test("an expired session never reaches the network", async () => {
  const {click, posts} = await load({mode: "supabase", session: {token: "t", email: "x", exp: Date.now() - 1000}});
  const btn = click({act: "rmremote", id: "a"});
  click(btn.dataset, btn);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(posts.length, 0);
});

test("history page lists ledger entries, marks the head, and offers roll back / fast-forward when signed in", async () => {
  const ev = (seq, action, id, superseded = false) => ({seq, at: "2026-10-18T00:00:00Z", action, match_id: id, by_email: "u", note: null, superseded, data: {date: "2026-10-17", map: "Dust2", score: [13, 10]}});
  const events = [ev(4, "add", "d", false), ev(3, "add", "c", true), ev(2, "remove", "a"), ev(1, "add", "a")];
  const fetchImpl = async (u, o, d) => {
    const ok = b => ({ok: true, status: 200, json: async () => b});
    if (u.includes("match_events")) return ok(events);
    if (u.includes("ledger_head")) return ok([{seq: 2}]);
    if (u.includes("ledger_audit")) return ok([]);
    return d(u, o);
  };
  const session = {token: "t", email: "x@y.z", exp: Date.now() + 3.6e6};
  const {runAsync, el} = await load({mode: "supabase", session, fetchImpl});
  await runAsync("historyView()");
  const html = el("#app").innerHTML;
  assert.match(html, /current/);
  assert.match(html, /Fast-forward to here/, "entry 4 is after the head and live");
  assert.match(html, /Roll back to here/, "entry 1 is before the head");
  assert.match(html, /class="discarded"/, "entry 3 was superseded");
  assert.equal((html.match(/Fast-forward to here/g) || []).length, 1, "discarded entries cannot be fast-forwarded to");
});

test("history is read-only (no action buttons) when signed out", async () => {
  const fetchImpl = async (u, o, d) => u.includes("match_events") ? {ok: true, json: async () => []} : u.includes("ledger_head") ? {ok: true, json: async () => [{seq: 0}]} : u.includes("ledger_audit") ? {ok: true, json: async () => []} : d(u, o);
  const {runAsync, el} = await load({mode: "supabase", fetchImpl});
  await runAsync("historyView()");
  assert.doesNotMatch(el("#app").innerHTML, /data-act="ledger"/);
  assert.match(el("#app").innerHTML, /Read-only/);
});

test("scoreboard rows are colour-coded by team, and the colour follows the player across maps", async () => {
  const {run} = await load();
  const html = run(`gameHtml(DB.games.find(g => g.date === '2026-10-17' && g.map === 'Dust2'))`);
  assert.equal((html.match(/<tr class="tA">/g) || []).length, 5, "five players on team A");
  assert.equal((html.match(/<tr class="tB">/g) || []).length, 5, "five players on team B");
  assert.match(html, /pill tA/); assert.match(html, /pill tB/);
  // OATH (Will) is on the winning team A in both maps: same colour even though sides/maps differ.
  const rowOf = (h, name) => h.split("<tr").find(r => r.includes(name));
  const anubis = run(`gameHtml(DB.games.find(g => g.date === '2026-10-17' && g.map === 'Anubis'))`);
  assert.match(rowOf(html, "OATH"), /class="tA"/);
  assert.match(rowOf(anubis, "OATH"), /class="tA"/);
  assert.match(rowOf(html, "zDemoncake"), /class="tB"/);
});

test("sheet-only games have no team colours (teams are unknown there)", async () => {
  const {run} = await load();
  const html = run(`gameHtml(DB.games.find(g => g.date === '2026-03-28' && g.map === 'Nuke'))`);
  assert.doesNotMatch(html, /<tr class="t[AB]">/);
});

test("TEMPORARY gate check: this must fail the build", () => { assert.equal(1, 2); });
