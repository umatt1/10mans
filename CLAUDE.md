# 10 Mans stats site

Static site (no build step) for an in-house CS2 10-man league. Hosted on GitHub Pages; data lives in `data/*.json`.

## Data sources
- **Google Sheet** (public, link-shared): `1RknwngIMQYAuY7AwgZC3bijaTwWZDDh5yw4A6kZpnPM`. One tab per player, columns
  Map, Date, Kills, Death, Assist, KDA, HS %, DMG, Rounds, ADR. `scripts/sync.py` pulls every tab via the gviz CSV
  endpoint into `data/stats.json`; `.github/workflows/sync.yml` runs it every 6 hours and commits changes.
  The player list is hard-coded in `sync.py` (add new tabs there). Tabs Juicy, Megan, Nathan are currently empty.
- **Refrag** (refrag.gg): no public/official API. The web app (play.refrag.gg) talks to an undocumented
  `api-k8s.refrag.gg` that needs a login, so CI cannot use it. `data/matches.json` was a **one-time import**
  made 2026-10-17 by reading match pages in a logged-in Chrome session (Claude in Chrome), via
  `play.refrag.gg/matches?tab=uploads` -> each row -> "Match Page" (`/matches/<uuid>`). Values were copied into
  `scripts/import_refrag.py`, which writes `data/matches.json`. Re-run it only after editing its data.
  Only matches played with the Refrag Scrim mod and uploaded to the account show full scoreboards (Refrag Rating,
  KAST, roles). Older uploaded demos (2026-01-16, 02-22, 04-10) show only map and score ("Stats not available").
  These matches were hosted on a friend's account but also appear on the owner's account (Dave Blunts = Matt).
- **Not in either source:** draft picks, map pick/ban order, who captained. Those are only in the Discord posts.

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

## Hosting
Deployed on both GitHub Pages (https://umatt1.github.io/10mans/) and Vercel (https://10mans.vercel.app, project `10mans` under umatt1s-projects, git-connected so pushes auto-deploy). `config.js` + `supabase/` + `vercel.json` + `docs/MIGRATION.md`
wire in Supabase (project ref sipcpfxjjsxsdozdommz, region us-east-1): `matches` + `aliases` tables seeded, public read via RLS, uploads only through the `ingest-match` edge function (deployed via dashboard; JWT gateway verification must be OFF). In `supabase` mode the site reads matches/aliases from Supabase and `data/matches/` is no longer what the app reads (the GitHub upload flow is hidden). Sheet stats still come from `data/stats.json`.

## Site
`index.html` + `app.js` + `style.css` (HLTV-inspired). Hash routes: `#` overview, `#days[/date[/gN]]`, `#players`, `#p/<name>`,
`#maps`, `#records`, `#compare/<a>/<b>`, `#pivot?rows=&cols=&val=&chart=&day=&map=&min=`, `#contribute`.
Header toggle switches between the Google Sheet (all history, estimated "Rating*") and Refrag-only (official Rating/KAST),
persisted in localStorage. Teams per scrim day come from the first Refrag scoreboard; sheet-only days have no teams/series.
Matches added via the Contribute page preview live in localStorage only ("local"). Preview locally with `python3 -m http.server`.
