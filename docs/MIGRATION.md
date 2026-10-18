# Moving to Vercel + Supabase (friends sign in and upload games)

The site is plain static files, so Vercel needs no build step. Supabase adds the database, the shared login, and the
upload endpoint that validates files. Nothing here is active until you flip `mode` in `config.js`; GitHub Pages keeps working.

> **Status:** Vercel is done: https://10mans.vercel.app (project `10mans`, GitHub repo connected, redeploys on every push). Supabase project `10mans` (ref `sipcpfxjjsxsdozdommz`) is created, seeded (8 matches, 10 aliases), RLS on, `ingest-match` deployed, and `config.js` is in `supabase` mode.
> **Manual steps left (security settings, done in the dashboard):** (1) Edge Functions → ingest-match → turn **off** "Verify JWT with legacy secret" (the function checks the login itself; leaving it on makes browser uploads fail with 401/CORS), (2) Authentication → Users → add the shared user (auto-confirm), (3) Authentication → Sign In / Providers → turn **off** "Allow new users to sign up".

## 1. Supabase
1. Create a project. In **SQL editor**, run `supabase/schema.sql` (tables `matches` and `aliases`, public read, no direct writes).
2. **Authentication → Users → Add user**: create the shared account (e.g. `crew@10mans.local` + a password; tick "Auto confirm").
   Supabase logins are email-shaped, so a made-up address works as a "username". Turn **off** "Allow new users to sign up"
   (Authentication → Providers → Email) so nobody else can create accounts.
3. Deploy the upload function: `supabase functions deploy ingest-match --project-ref <ref>`.
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically. Never put the service role key in `config.js`.)
4. Seed existing data once: insert the files in `data/matches/` into `matches` and `data/aliases.json` into `aliases`
   (Table editor → import, or ask Claude to write the one-off script).

## 2. Vercel
1. Import the GitHub repo as a project. Framework preset **Other**, no build command, output directory `.`.
2. In the repo set `config.js` to:
   ```js
   window.TENMANS = { mode: "supabase", supabaseUrl: "https://<ref>.supabase.co", supabaseAnonKey: "<anon public key>" };
   ```
   The anon key is public by design; the row-level-security policies are what protect writes.
3. Keep the GitHub Action: it still syncs the Google Sheet into `data/stats.json` every 6 hours, which Vercel redeploys on push.

## How uploading works
Contribute page → sign in → drop the exported `.json` files → Preview → **Publish**. The browser POSTs them to the
`ingest-match` function with the user's token; the function checks the login, validates each file with the same rules as
`scripts/build_matches.py`, rejects duplicates, and inserts. The page then reloads from Supabase.

## Caveats
- Not yet tested against a live Supabase project: the function and `config.js` mode were written from the documented APIs.
  Smoke-test with one match before handing out the login.
- Everyone shares one login, so uploads are attributable only to that account.
- Tokens last an hour by default; the page asks you to sign in again afterwards.
- The Google Sheet stays the source for per-player history; it is not moved into Supabase.
