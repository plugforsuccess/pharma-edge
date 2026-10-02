from datetime import date

from ldp.cadence import in_buy_window, may_buy


def test_buy_window(cfg):
    c = cfg.cadence   # 01-15, 21 days
    assert in_buy_window(date(2027, 1, 15), c)
    assert in_buy_window(date(2027, 2, 4), c)
    assert not in_buy_window(date(2027, 2, 5), c)
    assert not in_buy_window(date(2027, 1, 14), c)


def test_window_straddles_new_year(cfg):
    assert in_buy_window(date(2027, 1, 5), cfg.cadence, "12-20")


def test_once_per_year(cfg):
    c = cfg.cadence
    assert may_buy(date(2027, 1, 20), c, last_annual_buy=date(2026, 1, 20)) == (True, "annual buy window")
    assert may_buy(date(2027, 1, 20), c, last_annual_buy=date(2027, 1, 16))[0] is False
    assert may_buy(date(2027, 6, 1), c, last_annual_buy=date(2027, 1, 16))[0] is False


def test_reentry_any_time(cfg):
    assert may_buy(date(2027, 6, 1), cfg.cadence, last_annual_buy=date(2027, 1, 16), reentry=True)[0]


def test_user_window_feb_29(cfg):
    assert in_buy_window(date(2027, 2, 28), cfg.cadence, "02-29")
