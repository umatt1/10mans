# 10 Mans stats site

Static site (no build step) for an in-house CS2 10-man league. Hosted on Vercel; data lives in Supabase (ledger) plus `data/*.json` (sheet stats, and the static-mode fallback).

## Data sources
- **Google Sheet** (public, link-shared): id in `data/sheet.json`. One tab per player, columns
  Map, Date, Kills, Death, Assist, KDA, HS %, DMG, Rounds, ADR. `scripts/sync.py` has **no player list**: it exports the workbook as xlsx
  only to read the tab names, treats any tab whose header has the stat columns as a player (so a new tab = a new player; `Leaderboards`,
  `Pro Stats`, `Patch Notes` are skipped), pulls each via the gviz CSV endpoint into `data/stats.json`, keeps a tab's previous rows if its
  download fails, reuses the previous player list if the tab list fails, and refuses to overwrite with nothing. Runs in every Vercel build
  (see "Refreshing sheet data"). Header names are matched flexibly (`scripts/sync.py` ALIASES) and dates may be m/d/yy, m/d/yyyy or ISO.
  Juicy, Megan, Nathan have header-only tabs (no rows yet).
- **CSV / Excel uploads** (Contribute page, `import.js`): drop `.csv`/`.xlsx` next to match JSON. A workbook shaped like the sheet (tab = player)
  or any CSV with a `Player` column (else the file name is the player, editable). Required Map, Date, Kills, Death(s), Assist(s), Rounds,
  DMG-or-ADR; optional HS %, Player, Team, Result (W/L). `.xlsx` is read with a dependency-free zip+XML reader on `DecompressionStream`
  (`.xls` is rejected with a message). Rows are keyed `player|date|map`: rows the site already has are skipped, rows with different numbers
  are listed as conflicts and skipped (never overwritten), name case is matched to existing players, new names create new players.
  Publishing writes one ledger entry per game: `{kind:"stats", id, date, map, rounds, source:"upload", players:[{name,k,d,a,hs,dmg,rounds,team?,win?}]}`
  (no `score`; id = content hash so the same upload twice is refused). `buildDB` merges these into the **Sheet source only** (Refrag source
  = official scoreboards only) after the sheet rows, first-wins on `player|date|map`, so re-uploading can never double count. Optional
  Team/Result give a sheet-only day teams (the day's first two team labels = A/B) and a series score; a scoreboard day always wins over labels.
  Uploaded games are badged "uploaded"/"sheet + upload" and signed-in users get "Remove uploaded stats" (ledger remove, undo in History).
  Publishing needs the Supabase version; in static mode uploads can only be "Add to this browser" (localStorage). Heuristic: Excel numeric HS
  values <= 1 are treated as fractions (33% stored as 0.33). Verified 2026-10-18 with the real exported sheet (700 KB, 21 tabs): 18 players,
  100 rows, all 100 already on the site, 0 conflicts; and in real Chrome end-to-end with a new player + Team/Result columns.
- **Refrag** (refrag.gg): no public/official API. The web app (play.refrag.gg) talks to an undocumented
  `api-k8s.refrag.gg` that needs a login, so CI cannot use it. `data/matches.json` was a **one-time import**
  made 2026-10-17 by reading match pages in a logged-in Chrome session (Claude in Chrome), via
  `play.refrag.gg/matches?tab=uploads` -> each row -> "Match Page" (`/matches/<uuid>`). Values were copied into
  `scripts/import_refrag.py`, which writes `data/matches.json`. Re-run it only after editing its data.
  Only matches played with the Refrag Scrim mod and uploaded to the account show full scoreboards (Refrag Rating,
  KAST, roles). Older uploaded demos (2026-01-16, 02-22, 04-10) show only map and score ("Stats not available").
  These matches were hosted on a friend's account but also appear on the owner's account (Dave Blunts = Matt).
- **Not in any source:** draft picks, map pick/ban order, who captained. Those are only in the Discord posts.

## Name mapping
Refrag in-game name -> sheet tab, matched on identical K/D/A in both 2026-10-17 scrims (`aliases` in matches.json):
OATH=Will, The Swooper=Morgan, Dave Blunts=Matt, Sema=Ethan, travypatty=Travis, The Za=Brandon,
Noah Jawn=Noah, zDemoncake=Cristian, ByMax=Max, Tigereye16=Mark.

## Sheet vs Refrag cross-check (2026-10-17)
- K/D/A and HS% agree for all 20 player-maps except Cristian on Anubis: sheet assists 6, Refrag 5.
- Sheet ADR is ~0.3-1.7 higher than Refrag's (sheet DMG/Rounds vs Refrag's own ADR); not an error, different calc.
- Sheet calls the map "Dust"; Refrag says "Dust2". The site normalizes to Dust2.
- Refrag demo dates are UTC-ish: Refrag "Apr 10" = sheet 4/11 (same three maps, same round counts).
- Sheet issues: Alfa's Ancient row is dated 4/26 but belongs to 4/25 (typo; the site filters it). Mirage/Ancient 3/28 and
  4/25 and everything before 3/28 only exist in one source: 3/28 and 4/25 are sheet-only (no Refrag upload);
  Refrag demos from 2026-01-16 (Inferno 15-9) and 02-22 (Inferno 13-5, Anubis 13-11) are not in the sheet at all.

## Match files and contributing
One JSON file per match in `data/matches/` (format on the site's Contribute page). `scripts/build_matches.py` validates them and
compiles `data/matches.json` (also run by `.github/workflows/sync.yml` on any push touching `data/matches/**`, and by
`validate.yml` on PRs). `tools/export-refrag-match.js` is the console/bookmarklet script contributors run on a Refrag match
page to produce a file. Aliases (Refrag in-game name -> sheet name) live in `data/aliases.json`.

## Ledger (Supabase mode)
Match data is an append-only ledger so every change can be rolled back / fast-forwarded:
- `match_events` (seq, action add|remove, match_id, data, by_email, note, superseded), `ledger_head` (one row: the seq the site shows),
  `ledger_audit` (rollbacks/fast-forwards). `matches` is a **view**: live `add` entries up to the head, minus later `remove`s.
  The old table was renamed `matches_legacy` (kept, not dropped). Nothing is ever hard-deleted; "remove" is an entry.
- Writes only via Postgres functions `ledger_add/_remove/_move` (service role only), which lock the head row so double-clicks and
  concurrent uploads are serialized; duplicates (same id, or same date+map+score) are refused in the database.
- The `ingest-match` edge function exposes them: `{action:"add",matches}`, `{action:"remove",id}`, `{action:"move",seq}`.
  Changing a match after the fact = remove + add. A new change while rolled back marks the undone entries `superseded` (kept, can't be fast-forwarded to).
- UI: History page (`#history`, Supabase mode only) lists entries and offers Roll back / Fast-forward / Step back / Step forward when signed in;
  a "Remove from site" button appears on each match for signed-in users. Destructive buttons need a second click. Publish locks while a request runs.
- Public tables expose `by_email` (the shared login's email) via the API; the owner said that is fine. Migration: `supabase/migrations/001_ledger.sql`.
- Applying SQL/function changes: Supabase dashboard SQL editor (it warns on UPDATE-without-WHERE; confirm the dialog) and Edge Functions
  editor (Deploy updates shows a confirm dialog that must be clicked). Keep **Verify JWT with legacy secret OFF** on `ingest-match`.

## Tests
`npm test` (Node 20 built-in runner, no dependencies) runs `tests/`: the real `app.js` is loaded into a vm with a fake DOM and stubbed fetch
(`tests/harness.js`), covering aggregation, game/series/team logic, validation, pivot, CSV, every view rendering, the Supabase loading path,
the Publish double-click guard, Remove/History actions, and `scripts/build_matches.py`. CI runs them on push/PR (`.github/workflows/test.yml`).
Ledger SQL tests: paste `supabase/tests/ledger.test.sql` into the SQL editor; it runs in one DO block that always raises, so it rolls back
(expected message: `LEDGER TESTS PASSED (all changes rolled back)`; confirm the "UPDATE without WHERE" warning, which is the test trying to move the head as a signed-in user).
Edge function code has no automated tests (no Deno here); it is only exercised through the SQL functions and manual calls.
Gotcha: objects created inside the vm have a different prototype, so `harness.run` returns JSON copies for `deepEqual`.

## Refreshing sheet data (no cron)
There is deliberately **no schedule** (owner worried about cost). Every Vercel build runs `python3 scripts/sync.py` first (buildCommand in
`vercel.json`), so *any deploy re-reads the Google Sheet*; if Google/the sheet fails it logs `SHEET SYNC FAILED` and ships the last committed
`data/stats.json`. Ways to refresh: (1) the Vercel **Deploy Hook** `refresh-sheet-data` (project 10mans, branch main, subject to the daily cooldown below; the URL is a SECRET
- never commit it. Vercel dashboard -> project -> Settings -> Git -> Deploy Hooks shows/regenerates it; POST it and a ~20s build runs; verified 2026-10-18), (2) Vercel dashboard
Deployments -> Redeploy (not tested), (3) any push to main, (4) Actions tab -> Sync stats -> Run workflow (commits stats.json; also reruns on
pushes touching data/matches/**). The footer "Sheet synced ..." time is when the last build fetched the sheet. Matches in Supabase are live
immediately and need no refresh. Not built: an in-site refresh button (would need the ingest-match edge function to call the hook, with the hook
URL as a Supabase secret).

### Once-a-day cooldown on the refresh
`vercel.json` `ignoreCommand` runs `scripts/cooldown.js` (Vercel's Ignored Build Step) before every build. Each build writes `data/version.json`
(`scripts/stamp.py`: commit sha + when the sheet was last read; gitignored, only exists in the deployed output). A **production rebuild of the
same commit** (deploy-hook call or dashboard Redeploy) is cancelled in ~1s if the live `version.json` says the sheet was read < 24h ago
(`COOLDOWN_HOURS` env var changes it). **A new commit always builds** (so pushing is the override, and it restarts the 24h window), previews
are never held back, and any missing/garbled/unreachable info builds (fail-open, so it can never block a real deploy). A failed sheet fetch
keeps the old `syncedAt`, so it does not start a cooldown. Verified 2026-10-18: 3 hook calls -> 3 Canceled deployments (~0.9s each), live data
unchanged. Unit-tested in `tests/cooldown.test.js`; the "allowed again after 24h" path is only unit-tested (not waited out live).

## CI/CD
Push to `main` -> Vercel builds and deploys (git-connected). **Tests gate the deploy:** `vercel.json` sets `buildCommand: "npm test"`, so a
failing test = failed Vercel build = the previous production deployment keeps serving (verified 2026-10-18 on branch `gate-check` with a
deliberately failing test: "Command npm test exited with 1"; the same branch with the test removed built Ready). Branch/PR pushes get
preview deployments that run the same gate. GitHub Actions `Tests` (`test.yml`) runs the same suite and shows a check on commits/PRs;
`validate.yml` checks match files on PRs; `sync.yml` (manual + on match-file pushes only; no cron) rebuilds `data/matches.json` + syncs the sheet and
its commit redeploys through the same gate. Not gated / manual: Supabase SQL migrations and the `ingest-match` edge function (applied via the
dashboard); no branch protection is enabled, so a direct push to main still deploys if (and only if) the build's tests pass.
Vercel builds on Node 24 with Python available; `npm test` uses `node --test tests/*.test.js` (a directory arg is not portable across Node versions).

## Hosting
Deployed on Vercel (https://10mans.vercel.app, project `10mans` under umatt1s-projects, git-connected so pushes auto-deploy). The GitHub Pages copy was turned off on 2026-10-18 at the owner's request. `config.js` + `supabase/` + `vercel.json` + `docs/MIGRATION.md`
wire in Supabase (project ref sipcpfxjjsxsdozdommz, region us-east-1): `matches` + `aliases` tables seeded, public read via RLS, uploads only through the `ingest-match` edge function (deployed via dashboard; JWT gateway verification must be OFF). In `supabase` mode the site reads matches/aliases from Supabase and `data/matches/` is no longer what the app reads (the GitHub upload flow is hidden). Sheet stats still come from `data/stats.json`.

## Site
`index.html` + `app.js` + `style.css` (HLTV-inspired). Hash routes: `#` overview, `#days[/date[/gN]]`, `#players`, `#p/<name>`,
`#maps`, `#records`, `#compare/<a>/<b>`, `#pivot?rows=&cols=&val=&chart=&day=&map=&min=`, `#contribute`.
Header toggle switches between the Google Sheet (all history, estimated "Rating*") and Refrag-only (official Rating/KAST),
persisted in localStorage. Teams per scrim day come from the first Refrag scoreboard; team A/B colours (blue/orange) appear on scoreboards, the scrim-day header, day leaderboard + MVP, the Overview leaderboard *only when a single scrim day is filtered* (A/B are per-day labels, so all-time rows deliberately carry no team), records (dots), pivot player labels (only with a day chosen), player log + by-day table, and compare's shared-maps table; sheet-only days have no teams/series.
Matches added via the Contribute page preview live in localStorage only ("local"). Preview locally with `python3 -m http.server`.
