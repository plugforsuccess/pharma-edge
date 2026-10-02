import pytest

from ldp.ladder import allocate_contracts, build_ladder, rungs_hit


def one_rung(rate):
    return build_ladder(basis=10_000, targets=[1.0], fractions=[1.0], original_contracts=3,
                        rate_at_gain=lambda g: rate)[0]


# ── Required cases ─────────────────────────────────────────────────

def test_long_term_20_8():
    r = one_rung(0.208)
    assert round(r.required_gain) == 12_626
    assert round(r.exit_value) == 22_626
    assert round(r.exit_multiple, 2) == 2.26


def test_long_term_28_8():
    r = one_rung(0.288)
    assert round(r.required_gain) == 14_045
    assert round(r.exit_value) == 24_045
    assert round(r.exit_multiple, 2) == 2.40


# ── Mechanics ──────────────────────────────────────────────────────

def test_default_ladder_rungs_and_equal_thirds():
    rungs = build_ladder(basis=10_000, targets=[1, 2, 3], fractions=[1 / 3] * 3, original_contracts=3,
                         rate_at_gain=lambda g: 0.238)
    assert [r.contracts for r in rungs] == [1, 1, 1]
    assert [round(r.exit_multiple, 2) for r in rungs] == [2.31, 3.62, 4.94]


def test_rate_depends_on_gain_is_solved_to_fixed_point():
    # 15% up to $10k of gain, 20% above → the solved rate is the one at the solved gain.
    r = build_ladder(basis=10_000, targets=[1.0], fractions=[1.0], original_contracts=1,
                     rate_at_gain=lambda g: 0.15 if g <= 10_000 else 0.20)[0]
    assert r.rate == 0.20 and r.required_gain == pytest.approx(12_500)


@pytest.mark.parametrize("n,expected", [(3, [1, 1, 1]), (4, [2, 1, 1]), (1, [1, 0, 0]), (10, [4, 3, 3])])
def test_contract_allocation_sums_to_position(n, expected):
    alloc = allocate_contracts(n, [1 / 3] * 3)
    assert alloc == expected and sum(alloc) == n


def test_rungs_hit_skips_filled_and_empty():
    rungs = build_ladder(basis=10_000, targets=[1, 2, 3], fractions=[1 / 3] * 3, original_contracts=1,
                         rate_at_gain=lambda g: 0.2)
    assert [r.index for r in rungs_hit(rungs, 10.0, frozenset())] == [0]       # rungs 1–2 have 0 contracts
    assert rungs_hit(rungs, 10.0, frozenset({0})) == []


def test_invalid_basis():
    with pytest.raises(ValueError):
        build_ladder(basis=0, targets=[1], fractions=[1], original_contracts=1, rate_at_gain=lambda g: 0.2)
