-- No trading on a user's behalf (owner, 2026-10-19: "Investment adviser
-- status needs to be removed"). Cash Moves publishes the same information to
-- every subscriber and never manages an account, so:
--   * no account can be managed — the LDP engine's auto-trade path needs
--     account_tier = 'managed', so it can never run for anyone;
--   * the LDP audit log can never record a trade (suggestions, skips and
--     holds only).
-- The engine code stays (and its tests); these constraints are the gate.
-- Adds to the existing checks — nothing is removed.
alter table public.ldp_risk_profiles
  add constraint ldp_risk_profiles_no_managed check (account_tier = 'self_directed');

alter table public.ldp_audit_log
  add constraint ldp_audit_log_no_trades check (kind <> 'trade');
