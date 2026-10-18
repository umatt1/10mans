const test = require("node:test"), assert = require("node:assert/strict");
const {load} = require("./harness");

const H = "Map,Date,Kills,Death,Assist,HS %,DMG,Rounds";
const stats = (id, date, map, players, rounds = 20) => ({kind: "stats", id, date, map, rounds, source: "upload", players: players.map(p => ({k: 10, d: 10, a: 2, hs: 40, dmg: 1500, rounds, ...p}))});
const session = {token: "t", email: "x@y.z", exp: Date.now() + 3.6e6};
const csvFile = (name, text) => `{name: ${JSON.stringify(name)}, arrayBuffer: async () => new TextEncoder().encode(${JSON.stringify(text)}).buffer}`;

test("an uploaded new player appears everywhere; a row the sheet already has is not counted twice", async () => {
  const dup = {name: "Alfa", k: 18, d: 15, a: 6, hs: 33, dmg: 1728, rounds: 21};            // identical to Alfa's sheet row (Nuke, 3/28)
  const entry = stats("stats-t1", "2026-03-28", "Nuke", [{name: "Newbie", k: 12, d: 9, a: 3, dmg: 1600, rounds: 21}, dup], 21);
  const base = await load(), plus = await load({local: [entry]});
  assert.equal(plus.run("DB.players.Newbie.length"), 1);
  assert.equal(plus.run("DB.players.Alfa.length"), base.run("DB.players.Alfa.length"), "Alfa's duplicate row was ignored");
  assert.equal(plus.run("DB.games.length"), base.run("DB.games.length"), "joined the existing Mar 28 Nuke game, no new game");
  assert.equal(plus.run("DB.games.find(g => g.date === '2026-03-28' && g.map === 'Nuke').rows.length"), base.run("DB.games.find(g => g.date === '2026-03-28' && g.map === 'Nuke').rows.length") + 1);
  assert.match(plus.run("gameHtml(DB.games.find(g => g.date === '2026-03-28' && g.map === 'Nuke'))"), /sheet \+ upload/);
});

test("uploading the same rows twice (or in two files) never double counts", async () => {
  const a = stats("stats-a", "2026-11-07", "Nuke", [{name: "Newbie"}]), b = stats("stats-b", "2026-11-07", "Nuke", [{name: "Newbie"}]);
  const {run} = await load({local: [a, b]});
  assert.equal(run("DB.players.Newbie.length"), 1);
});

test("a brand-new game from an upload becomes its own game and is badged 'uploaded'", async () => {
  const {run} = await load({local: [stats("stats-n", "2026-11-14", "Inferno", [{name: "Matt"}, {name: "Will"}])]});
  assert.equal(run("DB.days[0]"), "2026-11-14");
  assert.match(run("gameHtml(DB.games.find(g => g.date === '2026-11-14'))"), /uploaded/);
});

test("refrag source ignores uploaded stats (official scoreboards only)", async () => {
  const {run} = await load({src: "refrag", local: [stats("stats-r", "2026-11-14", "Inferno", [{name: "Matt"}])]});
  assert.equal(run("DB.rows.length"), 20);
});

test("Team / Result columns give a sheet-only day teams, a series score and tinted rows", async () => {
  const e1 = stats("stats-t1", "2026-11-14", "Nuke", [{name: "Matt", team: "Reds", win: true}, {name: "Will", team: "Reds", win: true}, {name: "Max", team: "Blues", win: false}, {name: "Noah", team: "Blues", win: false}]);
  const e2 = stats("stats-t2", "2026-11-14", "Mirage", [{name: "Matt", team: "Reds", win: false}, {name: "Will", team: "Reds", win: false}, {name: "Max", team: "Blues", win: true}, {name: "Noah", team: "Blues", win: true}]);
  const e3 = stats("stats-t3", "2026-11-14", "Dust2", [{name: "Matt", team: "Reds", win: true}, {name: "Max", team: "Blues", win: false}]);
  const {run, el} = await load({local: [e1, e2, e3]});
  assert.deepEqual(run("DB.series['2026-11-14'].wins"), {A: 2, B: 1});
  assert.deepEqual(run("DB.series['2026-11-14'].A.sort()"), ["Matt", "Will"]);
  assert.equal(run("DB.players.Matt.filter(r => r.date === '2026-11-14').map(r => r.win).join()"), "true,false,true");
  assert.equal(run("DB.games.find(g => g.date === '2026-11-14' && g.map === 'Nuke').winner"), "A");
  run("daysView()");
  const day = el("#app").innerHTML; const seg = day.slice(day.indexOf('id="day-2026-11-14"'), day.indexOf('id="day-2026-10-17"'));
  assert.match(seg, /<tr class="tA">/); assert.match(seg, /<tr class="tB">/);
  assert.match(seg, /class="w">2<\/span> : <span class="x">1/);
});

test("without Team/Result there is no series, and the header shows 'vs' instead of a fake 0:0", async () => {
  const {run, el} = await load({local: [stats("stats-p", "2026-11-14", "Nuke", [{name: "Matt", team: "Reds"}, {name: "Max", team: "Blues"}])]});
  assert.equal(run("DB.series['2026-11-14'].wins.A + DB.series['2026-11-14'].wins.B"), 0);
  run("daysView()");
  const day = el("#app").innerHTML; const seg = day.slice(day.indexOf('id="day-2026-11-14"'), day.indexOf('id="day-2026-10-17"'));
  assert.match(seg, /class="big">vs</);
  assert.doesNotMatch(seg, /0<\/span> : <span/);
});

test("dropping a CSV shows a preview: counts, new players, and a player box when the file has no Player column", async () => {
  const {runAsync, run, el} = await load({mode: "supabase", session});
  run("contributeView()");
  await runAsync(`takeFiles([${csvFile("Newbie.csv", `${H}\nNuke,11/7/26,20,12,4,45%,2150,22\nMirage,11/7/26,8,7,3,33%,1200,22\nNuke,3/28/26,18,15,6,33%,1728,21`)}])`);
  const html = el("#spend").innerHTML;
  assert.match(html, /<b>3<\/b> rows read/); assert.match(html, /3 new/); assert.match(html, /Newbie/); assert.match(html, /New player/);
  assert.match(html, /data-act="sPlayer"/); assert.match(html, /value="Newbie"/);
  assert.match(html, /Publish 3 new rows \(3 games\)/);
  // Renaming the player box re-checks everything: as Alfa, the 3/28 Nuke row is one the site already has.
  const rename = run("SSRC[0].player = 'Alfa'; renderStatsPend(); $('#spend').innerHTML");
  assert.match(rename, /2 new/); assert.match(rename, /1 already on the site/);
  assert.doesNotMatch(rename, /New player/);
});

test("Publish sends the new rows once even when clicked repeatedly, then clears the preview", async () => {
  const {runAsync, run, click, posts} = await load({mode: "supabase", session});
  run("contributeView()");
  await runAsync(`takeFiles([${csvFile("all.csv", `Player,${H}\nNewbie,Nuke,11/7/26,20,12,4,45%,2150,22\nWill,Nuke,11/7/26,24,10,6,52%,2500,22`)}])`);
  const btn = click({act: "statsPublish"}); click(btn.dataset, btn); click(btn.dataset, btn);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(posts.length, 1);
  const sent = posts[0].body.matches[0];
  assert.equal(posts[0].body.action, "add");
  assert.equal(sent.kind, "stats"); assert.equal(sent.map, "Nuke"); assert.deepEqual(sent.players.map(p => p.name).sort(), ["Newbie", "Will"]);
  assert.equal(run("SSRC.length"), 0);
});

test("'Add to this browser' keeps the upload locally and it shows up on the site", async () => {
  const {runAsync, run, click} = await load();
  run("contributeView()");
  await runAsync(`takeFiles([${csvFile("Newbie.csv", `${H}\nNuke,11/7/26,20,12,4,45%,2150,22`)}])`);
  click({act: "statsLocal"});
  assert.equal(run("LOCAL.filter(l => l.kind === 'stats').length"), 1);
  assert.equal(run("DB.players.Newbie.length"), 1);
  assert.equal(run("SSRC.length"), 0);
});

test("a bad file is explained, not silently ignored", async () => {
  const {runAsync, run, el} = await load();
  run("contributeView()");
  await runAsync(`takeFiles([${csvFile("notes.csv", "hello,world\n1,2")}, {name: "old.xls", arrayBuffer: async () => new ArrayBuffer(4)}])`);
  const html = el("#spend").innerHTML;
  assert.match(html, /no stats header found/); assert.match(html, /\.xls files are not supported/);
});

test("signed-in users get 'Remove uploaded stats' on an uploaded game, and it removes every upload in that game", async () => {
  const remote = stats("stats-remote-1", "2026-11-14", "Nuke", [{name: "Matt"}]);
  const fetchImpl = async (u, o, d) => {
    if (u.includes("/rest/v1/matches")) { const r = await (await d(u, o)).json(); return {ok: true, status: 200, json: async () => [...r, {data: remote}]}; }
    return d(u, o);
  };
  const {run, click, posts} = await load({mode: "supabase", session, fetchImpl});
  const html = run("gameHtml(DB.games.find(g => g.date === '2026-11-14'))");
  assert.match(html, /data-act="rmupload" data-ids="stats-remote-1"/);
  const btn = click({act: "rmupload", ids: "stats-remote-1"}); click(btn.dataset, btn);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(posts.map(p => p.body), [{action: "remove", id: "stats-remote-1"}]);
});

test("History describes stats uploads instead of showing a blank score", async () => {
  const ev = [{seq: 1, at: "2026-10-18T00:00:00Z", action: "add", match_id: "s", by_email: "u", note: null, superseded: false, data: stats("s", "2026-11-14", "Nuke", [{name: "A"}, {name: "B"}])}];
  const fetchImpl = async (u, o, d) => u.includes("match_events") ? {ok: true, json: async () => ev} : u.includes("ledger_head") ? {ok: true, json: async () => [{seq: 1}]} : u.includes("ledger_audit") ? {ok: true, json: async () => []} : d(u, o);
  const {runAsync, el} = await load({mode: "supabase", session, fetchImpl});
  await runAsync("historyView()");
  assert.match(el("#app").innerHTML, /stats upload · 2 players/);
});

test("the Contribute page documents the stats format and accepts csv/xlsx", async () => {
  const {run, el} = await load({mode: "supabase", session});
  run("contributeView()");
  const html = el("#app").innerHTML;
  assert.match(html, /Stats file format/); assert.match(html, /accept="\.json,\.csv,\.tsv,\.xlsx,\.xls/); assert.match(html, /stats-template/);
});
