import pytest

from ldp.ladder import all_targets_done, allocate_contracts, allocate_with_runner, build_ladder, rungs_hit

PLAYBOOK = dict(targets=[1.0, 2.0], fractions=[0.70, 0.15])


def ladder(n, rate=0.238, basis=10_000, **kw):
    return build_ladder(basis=basis, original_contracts=n, rate_at_gain=lambda g: rate, **{**PLAYBOOK, **kw})


# ── Playbook cases ─────────────────────────────────────────────────

def test_targets_are_pre_tax_option_gains():
    r1, r2 = ladder(10)
    assert (r1.exit_multiple, r2.exit_multiple) == (2.0, 3.0)        # +100%, +200%
    assert (r1.exit_value, r2.exit_value) == (20_000, 30_000)


def test_seventy_percent_at_target_1_half_the_rest_at_target_2_rest_runs():
    alloc, runner = allocate_with_runner(20, [0.70, 0.15])
    assert alloc == [14, 3] and runner == 3                            # 70% / 15% / 15%
    alloc, runner = allocate_with_runner(50, [0.70, 0.15])
    assert alloc == [35, 8] and runner == 7 and sum(alloc) + runner == 50


def test_target_1_returns_cost_plus_profit():
    # Selling 70% at 2.0x returns 1.4x the whole position's cost.
    r1, _ = ladder(10)
    assert r1.contracts / 10 * r1.exit_value == pytest.approx(1.4 * 10_000)


def test_after_tax_figures_per_sale():
    # 7 of 10 contracts at 2.0x: $14,000 sale, $7,000 gain, 23.8% → $1,666 tax.
    r1, _ = ladder(10)
    assert r1.estimated_tax == pytest.approx(7_000 * 0.238)
    assert r1.after_tax_proceeds == pytest.approx(14_000 - 7_000 * 0.238)


def test_rate_looked_up_at_the_sale_gain():
    seen = []
    build_ladder(basis=10_000, original_contracts=10, rate_at_gain=lambda g: seen.append(g) or 0.2, **PLAYBOOK)
    assert seen[0] == pytest.approx(7_000) and seen[1] == pytest.approx(0.2 * 20_000)


@pytest.mark.parametrize("n,expected", [(1, ([1, 0], 0)), (2, ([2, 0], 0)), (3, ([2, 1], 0)), (7, ([5, 1], 1))])
def test_small_positions_still_add_up(n, expected):
    alloc, runner = allocate_with_runner(n, [0.70, 0.15])
    assert (alloc, runner) == expected and sum(alloc) + runner == n


def test_full_allocation_without_runner():
    assert allocate_with_runner(3, [0.5, 0.5]) == ([2, 1], 0)


@pytest.mark.parametrize("n,expected", [(3, [1, 1, 1]), (4, [2, 1, 1]), (1, [1, 0, 0]), (10, [4, 3, 3])])
def test_contract_allocation_sums_to_position(n, expected):
    alloc = allocate_contracts(n, [1 / 3] * 3)
    assert alloc == expected and sum(alloc) == n


def test_rungs_hit_skips_done_and_empty():
    rungs = ladder(1)                                      # 1 contract → all on target 1
    assert [r.index for r in rungs_hit(rungs, 10.0, frozenset())] == [0]
    assert rungs_hit(rungs, 10.0, frozenset({0})) == []
    assert all_targets_done(rungs, frozenset({0}))          # target 2 sells nothing


def test_all_targets_done_needs_every_selling_rung():
    rungs = ladder(10)
    assert not all_targets_done(rungs, frozenset({0}))
    assert all_targets_done(rungs, frozenset({0, 1}))


def test_invalid_basis():
    with pytest.raises(ValueError):
        build_ladder(basis=0, targets=[1], fractions=[1], original_contracts=1, rate_at_gain=lambda g: 0.2)
