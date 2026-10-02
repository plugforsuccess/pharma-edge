"""The offline tax snapshot must match the migration seed exactly."""

import json

from ldp.tools.export_tax_seed import DATA_DIR, MIGRATION, parse_migration, render


def test_snapshot_matches_migration():
    parsed = parse_migration(MIGRATION.read_text())
    assert parsed, "no tax seed parsed from migration"
    for year, data in parsed.items():
        path = DATA_DIR / f"tax_{year}.json"
        assert path.exists(), f"run python -m ldp.tools.export_tax_seed ({path.name} missing)"
        assert path.read_text() == render(data), f"{path.name} is stale — run python -m ldp.tools.export_tax_seed"


def test_seed_covers_50_states_and_dc():
    data = json.loads((DATA_DIR / "tax_2026.json").read_text())
    codes = {r["state_code"] for r in data["state_tax_rates"]}
    assert len(codes) == 51 and {"DC", "GA", "WA", "TX"} <= codes
    assert data["tax_year_config"]["niit"]["thresholds"] == {"single": 200000, "hoh": 200000, "mfj": 250000, "mfs": 125000}
