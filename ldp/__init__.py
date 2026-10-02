"""LDP — LEAPS Diversified Portfolio engine.

Risk tolerance decides what the bot may buy; the user's tax rate decides
when it sells; risk always beats tax.

Modules:
  config       every threshold (TOML-overridable)
  risk         risk tier + what each tier allows + compliance gate
  scoring      core sector-ETF ranking
  satellite    small-cap discovery, signals, hard rejects
  contracts    contract hard-reject filters + selection
  sizing       satellite caps, core budget → whole contracts
  allocator    annual buy / re-entry plan
  tax          per-user rates (incremental, stacked, NIIT), holding period
  ladder       after-tax exit ladder
  rules        daily sell rules, priority order
  orders       limit-only execution ladder
  engine       orchestration + audit
  audit        append-only audit records
  backtester   replay daily marks through the rules
  brokers      Tradier (live/sandbox) + dry-run
"""

__version__ = "0.1.0"
