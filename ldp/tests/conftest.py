from __future__ import annotations

from datetime import date, timedelta

import pytest

from ldp.config import LDPConfig
from ldp.models import Account, OptionQuote, Position

TODAY = date(2026, 10, 2)


@pytest.fixture
def cfg() -> LDPConfig:
    return LDPConfig()


def quote(
    *, symbol="XLK280121C00200000", underlying="XLK", dte=730, delta=0.75, bid=19.5, ask=20.5,
    oi=500, iv_rank=40.0, strike=200.0, option_type="call", today=TODAY,
) -> OptionQuote:
    return OptionQuote(symbol=symbol, underlying=underlying, option_type=option_type, strike=strike,
                       expiration=today + timedelta(days=dte), bid=bid, ask=ask, delta=delta,
                       open_interest=oi, iv_rank=iv_rank)


def position(
    *, held_days=100, dte=500, basis_per_contract=1000.0, mark=12.0, contracts=3, sleeve="core",
    thesis="intact", instrument="equity_option", sector="XLK", ticker="XLK", entry_price=10.0,
    rungs_filled=frozenset(), today=TODAY, position_id="p1", contracts_open=None, peak_mark=None,
    rungs_resting=frozenset(),
) -> Position:
    return Position(
        position_id=position_id, user_id="u1", ticker=ticker, sleeve=sleeve, instrument_type=instrument,
        contract_symbol=f"{ticker}TEST", expiration=today + timedelta(days=dte),
        original_contracts=contracts, contracts_open=contracts if contracts_open is None else contracts_open,
        basis_per_contract=basis_per_contract,
        entry_price=entry_price, mark=mark, acquired=today - timedelta(days=held_days),
        thesis_status=thesis, sector=sector, rungs_filled=rungs_filled, rungs_resting=rungs_resting,
        peak_mark=peak_mark,
    )


def account(*, tier="managed", value=100_000.0, cash=100_000.0) -> Account:
    return Account(account_id="A1", user_id="u1", tier=tier, value=value, cash=cash)
