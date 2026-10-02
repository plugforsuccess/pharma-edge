"""Export the tax-year seed from the Supabase migration to ldp/data/.

The migration is the single source of truth for tax figures. This
script parses its INSERTs and writes ``ldp/data/tax_<year>.json`` so the
engine can run offline (backtests, tests). tests/test_tax_data.py fails
if the JSON and the migration drift apart.

    python -m ldp.tools.export_tax_seed
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase" / "migrations" / "20261002000000_after_tax_leaps.sql"
DATA_DIR = ROOT / "ldp" / "data"

_JSONB = r"(NULL|'[^']*'::jsonb)"
_STATE_ROW = re.compile(
    r"^\s*\((\d{4}), '([A-Z]{2})', '((?:[^']|'')*)', '(\w+)', " + _JSONB + r", " + _JSONB
    + r", '(\w+)', ([\d.]+), " + _JSONB + r", '(\w+)', (NULL|'(?:[^']|'')*'), (NULL|'(?:[^']|'')*')\)[,]?\s*$",
    re.M,
)
_FED = re.compile(
    r"INSERT INTO public\.tax_year_config.*?VALUES \(\s*(\d{4}), (true|false),\s*'([^']*)'::jsonb,\s*'([^']*)'::jsonb,\s*'([^']*)'::jsonb",
    re.S,
)


def _j(v: str):
    return None if v == "NULL" else json.loads(v[1:-len("'::jsonb")])


def _t(v: str):
    return None if v == "NULL" else v[1:-1].replace("''", "'")


def parse_migration(sql: str) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for m in _FED.finditer(sql):
        year = int(m.group(1))
        out[year] = {
            "tax_year_config": {
                "tax_year": year,
                "is_current": m.group(2) == "true",
                "ordinary": json.loads(m.group(3)),
                "ltcg": json.loads(m.group(4)),
                "niit": json.loads(m.group(5)),
            },
            "state_tax_rates": [],
        }
    for m in _STATE_ROW.finditer(sql):
        year = int(m.group(1))
        out[year]["state_tax_rates"].append({
            "state_code": m.group(2),
            "state_name": m.group(3).replace("''", "'"),
            "kind": m.group(4),
            "ordinary": _j(m.group(5)),
            "ltcg": _j(m.group(6)),
            "ltcg_applies_to": m.group(7),
            "ltcg_exclusion_pct": float(m.group(8)),
            "stcg": _j(m.group(9)),
            "confidence": m.group(10),
            "source_url": _t(m.group(11)),
        })
    return out


def render(year_data: dict) -> str:
    return json.dumps(year_data, indent=1, sort_keys=True) + "\n"


def main() -> int:
    years = parse_migration(MIGRATION.read_text())
    if not years:
        print("no tax seed found in migration", file=sys.stderr)
        return 1
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for year, data in years.items():
        path = DATA_DIR / f"tax_{year}.json"
        path.write_text(render(data))
        print(f"wrote {path.relative_to(ROOT)} ({len(data['state_tax_rates'])} states)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
