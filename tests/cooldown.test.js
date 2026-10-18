const test = require("node:test"), assert = require("node:assert/strict");
const {decide} = require("../scripts/cooldown.js");

const now = Date.parse("2026-10-18T12:00:00Z");
const env = {VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "abc"};
const live = (hoursAgo, sha = "abc") => ({sha, syncedAt: new Date(now - hoursAgo * 36e5).toISOString()});
const go = (e, l, hours = 24) => decide({env: e, live: l, now, hours});

test("same commit rebuilt inside the cooldown is skipped", () => {
  const d = go(env, live(3));
  assert.equal(d.build, false);
  assert.match(d.why, /3\.0h/);
  assert.equal(go(env, live(23.9)).build, false);
});

test("same commit rebuilt after the cooldown builds", () => {
  assert.equal(go(env, live(24)).build, true);
  assert.equal(go(env, live(50)).build, true);
});

test("a new commit always builds, even seconds after the last sync", () => {
  const d = go(env, live(0.01, "older-sha"));
  assert.equal(d.build, true);
  assert.equal(d.why, "new commit");
});

test("preview/branch builds are never held back", () => {
  assert.equal(go({...env, VERCEL_ENV: "preview"}, live(1)).build, true);
});

test("missing, partial or malformed info fails open (builds)", () => {
  for (const l of [null, undefined, {}, {sha: "abc"}, {syncedAt: "2026-10-18T11:00:00Z"}, {sha: "abc", syncedAt: "not a date"}])
    assert.equal(go(env, l).build, true, JSON.stringify(l));
});

test("a timestamp in the future is not trusted", () => {
  assert.equal(go(env, live(-5)).build, true);
});

test("the cooldown length is configurable", () => {
  assert.equal(go(env, live(3), 2).build, true);
  assert.equal(go(env, live(3), 6).build, false);
});
