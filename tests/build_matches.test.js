const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), {spawnSync} = require("child_process");
const {root} = require("./harness");

// Runs scripts/build_matches.py in a scratch dir that holds only the given match files.
function build(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-"));
  fs.mkdirSync(path.join(dir, "data/matches"), {recursive: true});
  fs.writeFileSync(path.join(dir, "data/aliases.json"), JSON.stringify({Foo: "Bar"}));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, "data/matches", name), typeof body === "string" ? body : JSON.stringify(body));
  const r = spawnSync("python3", ["-I", path.join(root, "scripts/build_matches.py")], {cwd: dir, encoding: "utf8"});
  const out = r.status === 0 ? JSON.parse(fs.readFileSync(path.join(dir, "data/matches.json"), "utf8")) : null;
  return {status: r.status, err: r.stderr, out};
}
const good = {date: "2026-10-17", map: "Dust2", score: [13, 10]};

test("valid files build into matches.json, newest first, with generated ids and aliases", () => {
  const r = build({"a.json": good, "b.json": [{date: "2026-11-01", time: "8:00 PM", map: "Nuke", score: [13, 9]}]});
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out.matches.map(m => m.map), ["Nuke", "Dust2"]);
  assert.equal(r.out.matches[1].id, "2026-10-17-dust2-13-10");
  assert.deepEqual(r.out.aliases, {Foo: "Bar"});
});

test("a bad file fails the build and names the file and the problem", () => {
  const r = build({"ok.json": good, "bad.json": {date: "10/17/26", map: "Dust2", score: [13]}});
  assert.notEqual(r.status, 0);
  assert.match(r.err, /bad\.json: date must be YYYY-MM-DD/);
  assert.match(r.err, /bad\.json: score must be \[int, int\]/);
});

test("duplicates (same id, or same date+map+score) are rejected", () => {
  const r = build({"a.json": good, "b.json": {...good, id: "other"}});
  assert.notEqual(r.status, 0);
  assert.match(r.err, /duplicate of/);
});

test("invalid JSON and one-sided scoreboards are reported", () => {
  assert.match(build({"x.json": "{nope"}).err, /invalid JSON/);
  assert.match(build({"y.json": {...good, win: [{name: "a", k: 1, d: 1, a: 1}]}}).err, /win and lose must both be present/);
});

test("the committed match files and aliases build cleanly (a bad contributed file fails the gate)", () => {
  const r = spawnSync("python3", ["-I", path.join(root, "scripts/build_matches.py")], {cwd: root, encoding: "utf8"});
  assert.equal(r.status, 0, r.stderr);
});
