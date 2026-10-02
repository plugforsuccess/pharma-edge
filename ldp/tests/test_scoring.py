from ldp.scoring import SectorMetrics, score_sectors, top_tier


def m(t, r, above=True, rs=0.0):
    return SectorMetrics(t, r, r, r, rs, above)


def test_ranking_and_top_tier(cfg):
    scores = score_sectors([m("XLK", 30, rs=10), m("XLV", 10), m("XLE", -5, rs=-10), m("XLF", 20, above=False)],
                           cfg.core)
    assert [s.ticker for s in scores][:3] == ["XLK", "XLV", "XLE"]
    assert scores[-1].ticker == "XLF" and not scores[-1].eligible   # below 200-dma can't be top tier
    assert [s.ticker for s in top_tier(scores, cfg.core)] == ["XLK", "XLV", "XLE"]


def test_empty():
    from ldp.config import CoreConfig
    assert score_sectors([], CoreConfig()) == []
