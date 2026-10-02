"""Regenerate ldp/tests/fixtures/risk_tier_cases.json from ldp.risk.

The fixtures pin the exact tier, capping rule, rule results and UI copy
for a grid of onboarding answers. Python (tests/test_risk_parity.py)
and the TypeScript mirror (scripts/check-ldp-risk-tier.ts) must both
reproduce them byte-for-byte.

    python -m ldp.tools.export_risk_fixtures
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

from ldp.config import LDPConfig
from ldp.risk import OnboardingAnswers, compute_risk_profile, describe

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "risk_tier_cases.json"


def cases() -> list[dict]:
    cfg = LDPConfig()
    out = []
    grid = itertools.product(
        ("conservative", "moderate", "aggressive"),
        (0, 10_000, 24_999.99, 25_000, 50_000, 1_250_000),
        ("none", "some", "experienced"),
        (0, 1, 1.5, 2, 5, 30),
        ("managed", "self_directed"),
    )
    for tol, size, exp, years, acct in grid:
        a = OnboardingAnswers(tol, size, exp, years)
        p = compute_risk_profile(a, cfg.risk)
        out.append({
            "answers": {"stated_tolerance": tol, "account_size": size, "options_experience": exp, "horizon_years": years},
            "account_tier": acct,
            "expected": {
                "tier": p.tier,
                "capped_by": p.capped_by,
                "rules": [r.__dict__ for r in p.rules],
                "display": describe(p, acct, cfg),
            },
        })
    return out


def render() -> str:
    return json.dumps(cases(), indent=1, sort_keys=True) + "\n"


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render())
    print(f"wrote {len(cases())} cases to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
