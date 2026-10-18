-- Run once in the Supabase SQL editor.
create table if not exists public.matches (
  id          text primary key,
  date        date not null,
  map         text not null,
  score       int[] not null check (array_length(score, 1) = 2),
  data        jsonb not null,            -- the full match file, same format as data/matches/*.json
  uploaded_by uuid references auth.users,
  created_at  timestamptz not null default now()
);
create unique index if not exists matches_dedupe on public.matches (date, lower(map), (score[1]), (score[2]));

create table if not exists public.aliases (
  ingame text primary key,               -- Refrag in-game name
  player text not null                   -- name used on the site / in the sheet
);

alter table public.matches enable row level security;
alter table public.aliases enable row level security;

-- Anyone can read. Nobody can write directly: uploads go through the ingest-match
-- edge function, which checks the login, validates the file, and writes with the service role.
create policy "public read matches" on public.matches for select using (true);
create policy "public read aliases" on public.aliases for select using (true);
