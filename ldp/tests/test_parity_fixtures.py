"""Generated artifacts shared with the edge function must be current."""

from ldp.tools import export_edge_config, export_risk_fixtures


def test_edge_config_is_current():
    assert export_edge_config.OUT.read_text() == export_edge_config.render(), \
        "run python -m ldp.tools.export_edge_config"


def test_risk_fixtures_are_current():
    assert export_risk_fixtures.OUT.read_text() == export_risk_fixtures.render(), \
        "run python -m ldp.tools.export_risk_fixtures (and re-run npm run ldp:risk:check)"
