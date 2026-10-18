const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const {load} = require("./harness");

const session = {token: "t", email: "x@y.z", exp: Date.now() + 3.6e6};
const hoursAgo = h => ({sha: "abc", syncedAt: new Date(Date.now() - h * 36e5).toISOString()});
const settle = ms => new Promise(r => setTimeout(r, ms));

test("the button only exists for signed-in users on the Supabase site", async () => {
  const out = await load({mode: "supabase", version: hoursAgo(30)}); out.run("contributeView()");
  assert.doesNotMatch(out.el("#app").innerHTML, /data-act="refresh"|id="refresh"/, "signed out: no refresh box");
  const inn = await load({mode: "supabase", session, version: hoursAgo(30)}); inn.run("contributeView()"); await settle(30);
  assert.match(inn.el("#app").innerHTML, /id="refresh"/);
  const stat = await load({version: hoursAgo(30)}); stat.run("contributeView()");
  assert.doesNotMatch(stat.el("#app").innerHTML, /id="refresh"/, "static site has no backend to call");
});

test("inside the 24h window the button is disabled with a countdown and clicking sends nothing", async () => {
  const {run, el, click, posts} = await load({mode: "supabase", session, version: hoursAgo(3)});
  run("contributeView()"); await settle(30);
  const box = el("#refresh").innerHTML;
  assert.match(box, /data-act="refresh" disabled/);
  assert.match(box, /available again in 20h/);
  click({act: "refresh"}); await settle(60);
  assert.equal(posts.length, 0);
});

test("after 24h one click starts the rebuild, even if clicked repeatedly, then picks up the new data", async () => {
  const {run, click, posts, gets, setVersion, el} = await load({mode: "supabase", session, version: hoursAgo(30)});
  run("contributeView()"); await settle(30);
  assert.doesNotMatch(el("#refresh").innerHTML, /data-act="refresh" disabled/);
  const before = gets.stats;
  const btn = click({act: "refresh"}); click(btn.dataset, btn); click(btn.dataset, btn);
  await settle(80);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, {action: "refresh"});
  assert.equal(run("BUSY"), true, "locked while waiting for the build");
  setVersion(hoursAgo(0));                       // the new deployment is now serving
  await settle(120);
  assert.equal(run("BUSY"), false);
  assert.ok(gets.stats > before, "stats.json was re-read after the rebuild");
});

test("if the rebuild never shows up the user is told, and the button unlocks", async () => {
  const {run, click, posts} = await load({mode: "supabase", session, version: hoursAgo(30)});
  run("contributeView()"); await settle(30);
  click({act: "refresh"});
  await settle(500);                              // 36 polls x 2 ms
  assert.equal(posts.length, 1);
  assert.equal(run("BUSY"), false);
});

test("a server refusal (e.g. the secret is not set) is reported and does not leave the button locked", async () => {
  const fetchImpl = async (u, o, d) => (o?.method === "POST" && /ingest-match/.test(u))
    ? {ok: false, status: 501, json: async () => ({error: "Refresh isn't set up yet: add the VERCEL_DEPLOY_HOOK_URL secret"})} : d(u, o);
  const {run, click, el} = await load({mode: "supabase", session, version: hoursAgo(30), fetchImpl});
  run("contributeView()"); await settle(30);
  click({act: "refresh"}); await settle(80);
  assert.equal(run("BUSY"), false);
  assert.match(el("#toast").textContent, /isn't set up yet/);
});

test("edge function: refresh calls the hook with POST, and reports missing secret / Vercel errors / network failure", async () => {
  const ts = fs.readFileSync(path.join(__dirname, "../supabase/functions/ingest-match/index.ts"), "utf8");
  const i = ts.indexOf("export async function triggerRefresh"), j = ts.indexOf("\n}\n", i);
  const strip = s => s.replace(/: any/g, "").replace(/^export /, "");
  const triggerRefresh = new Function(`${strip(ts.slice(i, j + 3))}\nreturn triggerRefresh;`)();
  const calls = [];
  const ok = await triggerRefresh("https://hook", async (u, o) => { calls.push([u, o.method]); return {ok: true, status: 201}; });
  assert.deepEqual([ok.status, ok.body, calls], [200, {ok: true}, [["https://hook", "POST"]]]);
  const missing = await triggerRefresh(undefined, async () => { throw new Error("must not be called"); });
  assert.equal(missing.status, 501); assert.match(missing.body.error, /VERCEL_DEPLOY_HOOK_URL/);
  assert.equal((await triggerRefresh("h", async () => ({ok: false, status: 404}))).status, 502);
  assert.equal((await triggerRefresh("h", async () => { throw new Error("net"); })).status, 502);
  assert.doesNotMatch(JSON.stringify([ok, missing]), /https:\/\/hook/, "the hook URL is never echoed back");
});
