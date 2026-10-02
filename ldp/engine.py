"""LDP engine — ties risk, allocator, rules, execution and audit together.

    engine = Engine(cfg, broker=TradierBroker.from_env(), audit=SupabaseAuditSink(), ...)
    engine.run_buys(user, ...)          # annual window / re-entry
    engine.run_daily(user, positions)   # every trading day

Execution only happens when the permission mode is "auto" (managed
account, and a risk tier that allows auto-trading the sleeve). Anything
else becomes a suggestion for the user to approve or place themselves.
Every trade, suggestion, skip and hold-for-long-term is audited.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass, field
from datetime import date
from typing import Callable, Mapping, Sequence

from .allocator import BuyPlan, PlannedTrade, plan_buys
from .audit import AuditRecord, AuditSink
from .brokers.base import Broker
from .config import LDPConfig
from .models import Account, OptionQuote, Position
from .orders import ExecutionResult, LimitOrderExecutor
from .risk import Permission, RiskProfile, permission
from . import ladder as ladder_mod
from .brokers.base import LimitOrder
from .rules import RateSource, SellDecision, evaluate_position, resolve_ladder
from .satellite import SatelliteCandidate, SatelliteEvaluation
from .scoring import SectorScore
from .sizing import size_core, size_satellite
from .tax import TAX_DISCLAIMER

IvRankProvider = Callable[[str], float | None]


@dataclass(frozen=True)
class UserContext:
    user_id: str
    account: Account
    risk: RiskProfile
    rate_source: RateSource
    allow_catalyst_plays: bool = False
    buy_window_start: str | None = None
    last_annual_buy: date | None = None
    ladder_targets: tuple[float, ...] | None = None
    ladder_fractions: tuple[float, ...] | None = None
    runner_trail_pct: float | None = None


@dataclass
class Outcome:
    kind: str                # trade | suggestion | skip | hold
    action: str
    ticker: str
    detail: dict = field(default_factory=dict)


def fetch_chain(broker: Broker, ticker: str, today: date, cfg: LDPConfig, iv_rank: IvRankProvider) -> list[OptionQuote]:
    """LEAPS-dated chain for ``ticker`` with the underlying's IV rank attached."""
    lo = cfg.contracts.min_dte_days
    hi = cfg.contracts.target_dte_days + 365
    rank = iv_rank(ticker)
    quotes: list[OptionQuote] = []
    for exp in broker.get_expirations(ticker):
        if lo <= (exp - today).days <= hi:
            quotes.extend(dataclasses.replace(q, iv_rank=rank) for q in broker.get_chain(ticker, exp))
    return quotes


class Engine:
    def __init__(self, cfg: LDPConfig, *, broker: Broker, audit: AuditSink, iv_rank: IvRankProvider,
                 executor: LimitOrderExecutor | None = None) -> None:
        self.cfg = cfg
        self.broker = broker
        self.audit = audit
        self.iv_rank = iv_rank
        self.executor = executor or LimitOrderExecutor(broker, cfg.orders)

    # ── Audit helper ────────────────────────────────────────────────
    def _record(self, user: UserContext, perm: Permission, **kw) -> AuditRecord:
        rec = AuditRecord(
            user_id=user.user_id,
            risk_tier=user.risk.tier,
            risk_capped_by=user.risk.capped_by,
            risk_rules=[r.__dict__ for r in user.risk.rules],
            account_tier=user.account.tier,
            permission_mode=perm.mode,
            permission_reasons=list(perm.reasons),
            **kw,
        )
        self.audit.write(rec)
        return rec

    # ── Buys ────────────────────────────────────────────────────────
    def run_buys(
        self, user: UserContext, *, today: date, sector_scores: Sequence[SectorScore],
        satellite_evals: Sequence[SatelliteEvaluation], positions: Sequence[Position], reentry: bool = False,
    ) -> tuple[BuyPlan, list[Outcome]]:
        tickers = [s.ticker for s in sector_scores] + [e.candidate.ticker for e in satellite_evals if e.passed]
        chains = {t: fetch_chain(self.broker, t, today, self.cfg, self.iv_rank) for t in dict.fromkeys(tickers)}
        plan = plan_buys(
            today=today, cfg=self.cfg, account=user.account, risk=user.risk, sector_scores=sector_scores,
            satellite_evals=satellite_evals, chains=chains, positions=positions,
            last_annual_buy=user.last_annual_buy, user_window_start=user.buy_window_start, reentry=reentry,
        )
        outcomes: list[Outcome] = []
        for t in plan.trades:
            outcomes.append(self._buy(user, t))
        for s in plan.skips:
            perm = permission(s.sleeve, user.risk.tier, user.account.tier)
            self._record(user, perm, kind="skip", action="skip", ticker=s.ticker, sleeve=s.sleeve,
                         reason=s.reason, filter_rejects=[r for fr in s.contract_results for r in fr.rejects][:50],
                         sizing=None if s.sizing is None else s.sizing.to_record())
            outcomes.append(Outcome("skip", "skip", s.ticker, {"reason": s.reason}))
        return plan, outcomes

    def _buy(self, user: UserContext, t: PlannedTrade) -> Outcome:
        q = t.contract.quote
        common = dict(
            ticker=t.ticker, sleeve=t.sleeve, contract=q.symbol, filter_values=t.contract.values,
            score=t.score, score_components=t.score_components, thesis=t.thesis, sources=list(t.sources),
            sizing=t.sizing.to_record(),
            exit_ladder=[{"target": t, "fraction": f} for t, f in zip(*resolve_ladder(
                self.cfg, user.ladder_targets, user.ladder_fractions))],
            tax_rates={"note": TAX_DISCLAIMER},
        )
        if t.permission.mode != "auto":
            self._record(user, t.permission, kind="suggestion", action="buy", **common)
            return Outcome("suggestion", "buy", t.ticker, {"contracts": t.sizing.contracts, "symbol": q.symbol})
        res = self.executor.execute(account_id=user.account.account_id, underlying=t.ticker, option_symbol=q.symbol,
                                    side="buy_to_open", quantity=t.sizing.contracts, bid=q.bid, ask=q.ask,
                                    tag=f"ldp-{t.sleeve}")
        order: dict = res.to_record()
        target = self._place_target_order(user, t.ticker, q.symbol, res)
        if target is not None:
            order = {"open": order, "target_order": target}
        self._record(user, t.permission, kind="trade", action="buy", order=order, **common)
        return Outcome("trade", "buy", t.ticker, {"status": res.status, "filled": res.filled,
                                                   "target_order": target})

    def _place_target_order(self, user: UserContext, underlying: str, symbol: str, opened) -> dict | None:
        """Playbook: automate the first sell. Right after a buy fills, rest a
        GTC limit sell for Target 1's share of the filled contracts at
        Target 1's price (rounded UP to the tick, so it never sells short
        of the target). The daily check then leaves rung 0 to the broker."""
        o = self.cfg.orders
        if not o.place_target_order_on_entry or opened.filled < 1 or not opened.avg_fill_price:
            return None
        targets, fractions = resolve_ladder(self.cfg, user.ladder_targets, user.ladder_fractions)
        alloc, _runner = ladder_mod.allocate_with_runner(opened.filled, fractions)
        qty = alloc[0]
        if qty < 1:
            return None
        raw = opened.avg_fill_price * (1 + targets[0])
        price = round(math.ceil(round(raw / o.tick_size, 9)) * o.tick_size, 2)
        order = LimitOrder(underlying=underlying, option_symbol=symbol, side="sell_to_close", quantity=qty,
                           limit_price=price, duration=o.target_order_duration, tag="ldp-target1")
        try:
            order_id = self.broker.place_limit_order(user.account.account_id, order)
        except Exception as exc:   # the position is still open — the daily check sells at target instead
            return {"status": "rejected", "quantity": qty, "limit_price": price, "error": str(exc)}
        return {"status": "resting", "order_id": order_id, "quantity": qty, "limit_price": price,
                "duration": o.target_order_duration, "rung": 0}

    # ── Daily sell checks ───────────────────────────────────────────
    def run_daily(
        self, user: UserContext, positions: Sequence[Position], *, today: date,
        satellites: Mapping[str, SatelliteCandidate] | None = None,
        annual_review: bool = False, top_tier_sectors: frozenset[str] | None = None,
    ) -> list[tuple[Position, SellDecision, Outcome | None]]:
        out = []
        for pos in positions:
            if pos.contracts_open <= 0:
                continue
            dte = pos.dte(today)
            roll_chain: Sequence[OptionQuote] = ()
            if dte is not None and dte < self.cfg.exits.roll_dte_days:
                roll_chain = fetch_chain(self.broker, pos.ticker, today, self.cfg, self.iv_rank)
            d = evaluate_position(
                pos, today=today, rate_source=user.rate_source, cfg=self.cfg,
                satellite=(satellites or {}).get(pos.ticker), allow_catalyst_plays=user.allow_catalyst_plays,
                roll_chain=roll_chain, annual_review=annual_review, top_tier_sectors=top_tier_sectors,
                ladder_targets=user.ladder_targets, ladder_fractions=user.ladder_fractions,
                runner_trail_pct=user.runner_trail_pct,
            )
            out.append((pos, d, self._act(user, pos, d, today, positions)))
        return out

    def _act(self, user: UserContext, pos: Position, d: SellDecision, today: date,
             positions: Sequence[Position] = ()) -> Outcome | None:
        perm = permission(pos.sleeve, user.risk.tier, user.account.tier)
        common = dict(ticker=pos.ticker, sleeve=pos.sleeve, contract=pos.contract_symbol,
                      tax_rates={**d.rates, "note": TAX_DISCLAIMER}, exit_ladder=d.ladder,
                      sell_rule=d.rule_name, reason=d.reason)
        if d.action == "hold":
            return None
        if d.action == "hold_for_long_term":
            self._record(user, perm, kind="hold", action=d.action, **common)
            return Outcome("hold", d.action, pos.ticker, d.to_record())
        if perm.mode != "auto":
            # Includes "blocked": a conservative user holding a satellite
            # (e.g. after a tier change) still gets told to exit.
            self._record(user, perm, kind="suggestion", action=d.action, **common)
            return Outcome("suggestion", d.action, pos.ticker, d.to_record())

        quote = self._quote_for(pos, today)
        if quote is None or quote.bid is None or quote.ask is None:
            self._record(user, perm, kind="skip", action=d.action, **{**common, "reason": f"{d.reason}; no live quote"})
            return Outcome("skip", d.action, pos.ticker, {"reason": "no live quote"})
        res = self.executor.execute(account_id=user.account.account_id, underlying=pos.ticker,
                                    option_symbol=pos.contract_symbol, side="sell_to_close",
                                    quantity=d.contracts, bid=quote.bid, ask=quote.ask, tag=f"ldp-{d.rule_name}")
        rec_kw = {**common, "order": res.to_record()}
        if d.action == "roll" and d.replacement is not None and res.filled > 0:
            rec_kw["order"] = {"close": res.to_record(), "open": self._open_roll(user, pos, d, res, positions).to_record()}
            rec_kw["filter_values"] = d.replacement.values
        self._record(user, perm, kind="trade", action=d.action, **rec_kw)
        return Outcome("trade", d.action, pos.ticker, {"status": res.status, "filled": res.filled})

    def _open_roll(self, user: UserContext, pos: Position, d: SellDecision, closed, positions: Sequence[Position]):
        q = d.replacement.quote
        proceeds = (closed.avg_fill_price or 0) * 100 * closed.filled
        if pos.sleeve == "satellite":
            sz = size_satellite(requested_dollars=proceeds, contract_cost=q.contract_cost or 0,
                                account_value=user.account.value,
                                existing_satellite_total=sum(p.basis for p in positions if p.sleeve == "satellite"
                                                             and p.position_id != pos.position_id and p.contracts_open > 0),
                                available_cash=user.account.cash + proceeds, cfg=self.cfg.satellite)
        else:
            sz = size_core(budget_dollars=proceeds, contract_cost=q.contract_cost or 0,
                           available_cash=user.account.cash + proceeds)
        if sz.skipped:
            return ExecutionResult(None, "unfilled", 0, 0, None, events=[{"event": "skipped", "reason": sz.reason}])
        opened = self.executor.execute(account_id=user.account.account_id, underlying=pos.ticker, option_symbol=q.symbol,
                                       side="buy_to_open", quantity=sz.contracts, bid=q.bid, ask=q.ask, tag="ldp-roll")
        target = self._place_target_order(user, pos.ticker, q.symbol, opened)
        if target is not None:
            opened.events.append({"event": "target_order", **target})
        return opened

    def _quote_for(self, pos: Position, today: date) -> OptionQuote | None:
        if pos.expiration is None or pos.contract_symbol is None:
            return None
        for q in self.broker.get_chain(pos.ticker, pos.expiration):
            if q.symbol == pos.contract_symbol:
                return q
        return None
