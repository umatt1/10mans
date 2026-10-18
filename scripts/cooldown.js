// Vercel "Ignored Build Step": exit 0 = skip this build, exit 1 = build.
// Stops the deploy-hook / Redeploy "refresh the sheet" button from running more than once per COOLDOWN_HOURS.
// A build is skipped only when it is a production rebuild of the SAME commit that is already live and the sheet was read
// less than COOLDOWN_HOURS ago. A new commit always builds. Anything unexpected (no info, bad data, network error) builds,
// so this can never block a real deploy.
const HOURS = Number(process.env.COOLDOWN_HOURS || 24);

function decide({env, live, now = Date.now(), hours = HOURS}) {
  if (env.VERCEL_ENV !== "production") return {build: true, why: "not a production build"};
  if (!live || !live.sha || !live.syncedAt) return {build: true, why: "no previous version info"};
  if (live.sha !== env.VERCEL_GIT_COMMIT_SHA) return {build: true, why: "new commit"};
  const age = (now - Date.parse(live.syncedAt)) / 36e5;
  if (!(age >= 0)) return {build: true, why: "unreadable or future timestamp"};
  if (age < hours) return {build: false, why: `rebuild of the same commit ${age.toFixed(1)}h after the last sheet sync (cooldown ${hours}h)`};
  return {build: true, why: `cooldown over (${age.toFixed(1)}h since the last sheet sync)`};
}

async function main() {
  let live = null;
  try {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || "10mans.vercel.app";
    const r = await fetch(`https://${host}/data/version.json?t=${Date.now()}`, {signal: AbortSignal.timeout(8000), cache: "no-store"});
    if (r.ok) live = await r.json();
  } catch (e) { console.log("cooldown: could not read the live version, building anyway:", e.message); }
  const d = decide({env: process.env, live});
  console.log(`cooldown: ${d.build ? "BUILD" : "SKIP"} - ${d.why}`);
  process.exit(d.build ? 1 : 0);
}

if (require.main === module) main();
module.exports = {decide};
