-- What's driving each leader theme (owner, 2026-10-19: "build option 2").
-- One short news summary per industry theme per day, written by the
-- theme-notes edge function (Claude + web search, sources required) and read
-- by the Leaders list. Shared market commentary, not user data: authenticated
-- SELECT, service-role write only.
create table if not exists public.theme_notes (
  theme       text not null,
  as_of       date not null,
  etf         text,
  tickers     text[] not null default '{}',
  driver      text not null,
  driver_source jsonb,          -- { url, name, date }
  risks       jsonb not null default '[]'::jsonb,  -- [{ kind, text, url, name, date }]
  model       text,
  claude_call_id uuid,          -- claude_calls.id (no FK: adding one locks claude_calls)
  created_at  timestamptz not null default now(),
  primary key (theme, as_of)
);

alter table public.theme_notes enable row level security;

drop policy if exists theme_notes_select_authenticated on public.theme_notes;
create policy theme_notes_select_authenticated on public.theme_notes
  for select to authenticated using (true);

create index if not exists theme_notes_as_of_idx on public.theme_notes (as_of desc);
