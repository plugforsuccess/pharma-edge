from datetime import date

from ldp.allocator import plan_buys
from ldp.risk import OnboardingAnswers, compute_risk_profile
from ldp.satellite import SatelliteCandidate, evaluate
from ldp.scoring import SectorMetrics, score_sectors

from .conftest import account, position, quote

BUY_DAY = date(2027, 1, 20)


def risk(cfg, tolerance="aggressive"):
    return compute_risk_profile(OnboardingAnswers(tolerance, 100_000, "experienced", 5), cfg.risk)


def sectors(cfg):
    return score_sectors([SectorMetrics("XLK", 30, 30, 30, 10, True), SectorMetrics("XLV", 20, 20, 20, 5, True),
                          SectorMetrics("XLI", 10, 10, 10, 0, True), SectorMetrics("XLE", 0, 0, 0, -5, True)], cfg.core)


def sat_eval(cfg, ticker="RXRX"):
    c = SatelliteCandidate(ticker, "AI bio", "thesis", ("https://x",), 900e6, 100e6, momentum_pct=30,
                           institutional_change_pct=10, short_interest_pct=5)
    return evaluate(c, BUY_DAY, cfg.satellite)


def chains():
    q = lambda t, ask, delta=0.75: [quote(symbol=f"{t}C", underlying=t, ask=ask, bid=ask - 0.5, delta=delta, today=BUY_DAY)]
    return {"XLK": q("XLK", 20.0), "XLV": q("XLV", 15.0), "XLI": q("XLI", 12.0), "XLE": q("XLE", 9.0),
            "RXRX": [quote(symbol="RXRXC", underlying="RXRX", ask=4.0, bid=3.7, delta=0.65, today=BUY_DAY)]}


def plan(cfg, tier="aggressive", acct=None, positions=(), last=None, **kw):
    return plan_buys(today=kw.pop("today", BUY_DAY), cfg=cfg, account=acct or account(), risk=risk(cfg, tier),
                     sector_scores=sectors(cfg), satellite_evals=[sat_eval(cfg)], chains=chains(),
                     positions=list(positions), last_annual_buy=last, **kw)


def test_core_top_tier_split_equally(cfg):
    p = plan(cfg)
    core = [t for t in p.trades if t.sleeve == "core"]
    assert [t.ticker for t in core] == ["XLK", "XLV", "XLI"]
    # $30k / 3 = $10k each → floor(10k / (ask × 100)) contracts.
    assert [t.sizing.contracts for t in core] == [5, 6, 8]
    assert all(t.permission.mode == "auto" for t in core)


def test_aggressive_managed_satellite_auto_within_cap(cfg):
    [s] = [t for t in plan(cfg).trades if t.sleeve == "satellite"]
    assert s.permission.mode == "auto"
    assert s.sizing.allowed_dollars == 5_000 and s.sizing.contracts == 12
    assert s.thesis == "thesis" and s.sources == ("https://x",)


def test_moderate_satellite_suggest_only(cfg):
    [s] = [t for t in plan(cfg, "moderate").trades if t.sleeve == "satellite"]
    assert s.permission.mode == "suggest"


def test_conservative_never_trades_or_suggests_satellites(cfg):
    p = plan(cfg, "conservative")
    assert all(t.sleeve == "core" for t in p.trades)
    assert not any(s.sleeve == "satellite" for s in p.skips)


def test_self_directed_everything_suggest(cfg):
    p = plan(cfg, acct=account(tier="self_directed"))
    assert {t.permission.mode for t in p.trades} == {"suggest"}


def test_existing_satellites_shrink_new_buy(cfg):
    held = [position(sleeve="satellite", ticker="ABCD", sector=None, basis_per_contract=1_400, contracts=10,
                     position_id=f"s{i}") for i in range(1)]
    [s] = [t for t in plan(cfg, positions=held).trades if t.sleeve == "satellite"]
    assert s.sizing.allowed_dollars == 1_000 and s.sizing.contracts == 2


def test_cash_limits_buys_and_idle_cash_stays(cfg):
    p = plan(cfg, acct=account(cash=12_000))
    assert sum(t.sizing.cost for t in p.trades) <= 12_000
    assert p.cash_after >= 0


def test_outside_window_no_buys_but_reentry_allowed(cfg):
    assert not plan(cfg, today=date(2027, 6, 1)).allowed
    assert plan(cfg, today=date(2027, 6, 1), reentry=True).allowed


def test_already_bought_this_window(cfg):
    p = plan(cfg, last=date(2027, 1, 16))
    assert not p.allowed and p.trades == []


def test_sector_already_funded_is_skipped(cfg):
    held = [position(sector="XLK", ticker="XLK", basis_per_contract=2_000, contracts=5)]
    p = plan(cfg, positions=held)
    assert "XLK" not in [t.ticker for t in p.trades]
    assert any(s.ticker == "XLK" and "allocation" in s.reason for s in p.skips)


def test_no_passing_contract_is_skipped_with_rejects(cfg):
    c = chains()
    c["XLK"] = [quote(underlying="XLK", iv_rank=90, today=BUY_DAY)]
    p = plan_buys(today=BUY_DAY, cfg=cfg, account=account(), risk=risk(cfg), sector_scores=sectors(cfg),
                  satellite_evals=[], chains=c, positions=[], last_annual_buy=None)
    [skip] = [s for s in p.skips if s.ticker == "XLK"]
    assert "iv rank" in skip.contract_results[0].rejects[0]
