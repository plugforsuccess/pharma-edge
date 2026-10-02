from ldp.sizing import size_core, size_satellite


def test_single_buy_shrunk_to_per_name_cap(cfg):
    r = size_satellite(requested_dollars=8_000, contract_cost=500, account_value=100_000,
                       existing_satellite_total=0, cfg=cfg.satellite)
    assert r.allowed_dollars == 5_000
    assert (r.contracts, r.cost, r.skipped) == (10, 5_000, False)
    assert r.caps["binding"] == "per_name_room"


def test_new_buy_shrunk_to_remaining_total_cap(cfg):
    r = size_satellite(requested_dollars=5_000, contract_cost=900, account_value=100_000,
                       existing_satellite_total=14_000, cfg=cfg.satellite)
    assert r.allowed_dollars == 1_000
    assert (r.contracts, r.skipped) == (1, False)
    assert r.caps["binding"] == "total_room"


def test_shrunk_order_under_one_contract_is_skipped(cfg):
    r = size_satellite(requested_dollars=5_000, contract_cost=1_050, account_value=100_000,
                       existing_satellite_total=14_000, cfg=cfg.satellite)
    assert r.allowed_dollars == 1_000
    assert r.skipped and r.contracts == 0 and "under one contract" in r.reason


def test_exactly_one_contract_fits(cfg):
    r = size_satellite(requested_dollars=5_000, contract_cost=1_000, account_value=100_000,
                       existing_satellite_total=14_000, cfg=cfg.satellite)
    assert (r.contracts, r.skipped) == (1, False)


def test_existing_position_in_name_counts_toward_per_name_cap(cfg):
    r = size_satellite(requested_dollars=5_000, contract_cost=500, account_value=100_000,
                       existing_satellite_total=3_000, existing_in_name=3_000, cfg=cfg.satellite)
    assert r.allowed_dollars == 2_000


def test_total_cap_full_skips(cfg):
    r = size_satellite(requested_dollars=5_000, contract_cost=100, account_value=100_000,
                       existing_satellite_total=15_000, cfg=cfg.satellite)
    assert r.skipped and r.allowed_dollars == 0


def test_cash_limits_size(cfg):
    r = size_satellite(requested_dollars=5_000, contract_cost=500, account_value=100_000,
                       existing_satellite_total=0, available_cash=1_200, cfg=cfg.satellite)
    assert (r.allowed_dollars, r.contracts, r.caps["binding"]) == (1_200, 2, "cash")


def test_core_budget_to_contracts():
    r = size_core(budget_dollars=10_000, contract_cost=2_050)
    assert (r.contracts, r.cost) == (4, 8_200)
    assert size_core(budget_dollars=1_000, contract_cost=2_050).skipped
