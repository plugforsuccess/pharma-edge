-- Forward stock returns per replay trade (owner, 2026-10-05): the Triple event
-- stats on the entry chart read median 3 / 6 / 12-month returns from
-- replay_trades against the random-entry control, so the universe job stores
-- them per row. Already applied to production via MCP; filed for the record.
alter table public.replay_trades
  add column if not exists fwd_3m double precision,
  add column if not exists fwd_6m double precision,
  add column if not exists fwd_12m double precision,
  add column if not exists rand_3m double precision,
  add column if not exists rand_6m double precision,
  add column if not exists rand_12m double precision;
