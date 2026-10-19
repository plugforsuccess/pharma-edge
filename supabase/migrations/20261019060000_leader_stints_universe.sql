-- Leader record: "any stock" over each stay's own days (owner, 2026-10-19:
-- show the group result beside the S&P and any stock). univ_med / univ_avg =
-- the median / mean change of every stock in the universe from the join date
-- to the latest close. Additive.
alter table public.leader_stints
  add column if not exists univ_med numeric,
  add column if not exists univ_avg numeric;
