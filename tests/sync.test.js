const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), {spawnSync} = require("child_process");
const {root} = require("./harness");

// Runs a python snippet with scripts/sync.py imported as `sync` inside a scratch dir that has its own data/ folder.
function py(code, {previous} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "data/sheet.json"), JSON.stringify({sheetId: "X", excludeTabs: ["Patch Notes"]}));
  if (previous) fs.writeFileSync(path.join(dir, "data/stats.json"), JSON.stringify({updated: "old", players: previous}));
  const prog = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(root, "scripts"))}); import sync\n${code}`;
  const r = spawnSync("python3", ["-c", prog], {cwd: dir, encoding: "utf8"});
  const out = fs.existsSync(path.join(dir, "data/stats.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "data/stats.json"), "utf8")) : null;
  return {status: r.status, stdout: r.stdout, stderr: r.stderr, out};
}
const HEAD = "Map,Date,Kills,Death,Assist,KDA,HS %,DMG,Rounds,ADR";

test("header detection is flexible: aliases, case, % and spacing", () => {
  const r = py(`print(json.dumps([sync.header_map(h.split(',')) for h in ['${HEAD}', 'map,DATE,Kills,Deaths,Assists,HS%,Damage,Round', 'Player,Foo,Bar']]))`);
  const [a, b, c] = JSON.parse(r.stdout);
  assert.deepEqual(Object.values(a).sort(), ["a", "adr", "d", "dmg", "date", "hs", "k", "map", "rounds"].sort());
  assert.ok(b && Object.values(b).includes("hs") && Object.values(b).includes("dmg"));
  assert.equal(c, null);
});

test("rows parse with 2- and 4-digit years, percent signs, and ADR-only tabs", () => {
  const r = py(`print(json.dumps(sync.parse('${HEAD}\\nNuke,3/28/26,18,15,6,1.6,33%,1728,21,82.29\\nMirage,4/11/2026,8,7,11,2,12%,1218,16,76.13\\n,,,,,,,,,\\nAncient,not a date,1,1,1,1,1%,1,1,1')))`);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 2, "blank and unreadable-date lines are dropped");
  assert.deepEqual([rows[0].date, rows[1].date], ["2026-03-28", "2026-04-11"]);
  assert.deepEqual([rows[0].k, rows[0].hs, rows[0].dmg], [18, 33, 1728]);
  const adr = JSON.parse(py(`print(json.dumps(sync.parse('Map,Date,Kills,Death,Assist,ADR,Rounds\\nNuke,3/28/26,10,5,2,80,20')))`).stdout);
  assert.equal(adr[0].dmg, 1600, "damage is rebuilt from ADR x rounds when there is no DMG column");
});

test("a tab that is not a stats tab is ignored (parse returns None)", () => {
  assert.equal(py(`print(sync.parse('Player,Rating\\nMatt,1.2'))`).stdout.trim(), "None");
});

test("a brand-new tab is discovered and helper tabs are skipped, with no player list in the code", () => {
  const r = py(`
sync.list_tabs = lambda: ['Matt', 'Newbie', 'Patch Notes', 'Leaderboards']
sync.fetch_tab = lambda t: {'Matt': '${HEAD}\\nNuke,3/28/26,18,15,6,1.6,33%,1728,21,82.29', 'Newbie': '${HEAD}\\nMirage,4/11/26,8,7,11,2,12%,1218,16,76.13', 'Leaderboards': 'Name,Rating\\nMatt,1'}[t]
sync.main()`, {previous: {Matt: []}});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.out.players), ["Matt", "Newbie"]);
  assert.match(r.stdout, /new players: \['Newbie'\]/);
  assert.match(r.stdout, /Leaderboards/);
});

test("if one tab fails to download its previous rows are kept and the others still update", () => {
  const prev = {Matt: [{map: "Nuke", date: "2026-03-28", k: 1, d: 1, a: 1, hs: 0, dmg: 100, rounds: 10}], Max: []};
  const r = py(`
sync.list_tabs = lambda: ['Matt', 'Max']
def f(t):
    if t == 'Matt': raise OSError('boom')
    return '${HEAD}\\nMirage,4/11/26,8,7,11,2,12%,1218,16,76.13'
sync.fetch_tab = f
sync.main()`, {previous: prev});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.players.Matt.length, 1, "Matt kept his old row");
  assert.equal(r.out.players.Max.length, 1, "Max got the new row");
  assert.match(r.stderr, /kept its previous rows/);
});

test("if the tab list cannot be read the known players are reused; if nothing loads the file is not overwritten", () => {
  const prev = {Matt: [{map: "Nuke", date: "2026-03-28", k: 1, d: 1, a: 1, hs: 0, dmg: 100, rounds: 10}]};
  const ok = py(`
def boom(): raise OSError('no export')
sync.list_tabs = boom
sync.fetch_tab = lambda t: '${HEAD}\\nMirage,4/11/26,8,7,11,2,12%,1218,16,76.13'
sync.main()`, {previous: prev});
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(Object.keys(ok.out.players), ["Matt"]);
  const dead = py(`
sync.list_tabs = lambda: ['Matt']
def boom(t): raise OSError('down')
sync.fetch_tab = boom
sync.main()`);
  assert.notEqual(dead.status, 0);
  assert.equal(dead.out, null, "nothing written when nothing could be read");
});
