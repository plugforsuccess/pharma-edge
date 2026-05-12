"""Polygon historical options-data client for the backtest harness.

Caches every response to disk so a strategy edit doesn't re-hit the
API. Cache key is (ticker, date, kind). `kind` is one of:
  - 'chain_snapshot'   — full chain at end of trading day
  - 'option_aggs'      — 1-min bars for a single option contract
  - 'underlying_aggs'  — 1-min bars for an equity

Polygon options endpoints used:
  GET /v3/snapshot/options/{underlying}                        (chain)
  GET /v2/aggs/ticker/{option_ticker}/range/1/minute/{from}/{to}
  GET /v2/aggs/ticker/{underlying}/range/1/minute/{from}/{to}

Auth: MASSIVE_API_KEY env var. Reads from .env if present.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import requests

CACHE_DIR = Path(__file__).parent.parent / 'cache'
CACHE_DIR.mkdir(parents=True, exist_ok=True)
POLYGON_BASE = os.environ.get('POLYGON_BASE_URL', 'https://api.polygon.io')


class PolygonHistoryError(RuntimeError):
    pass


def _api_key() -> str:
    k = os.environ.get('MASSIVE_API_KEY') or os.environ.get('POLYGON_API_KEY')
    if not k:
        raise PolygonHistoryError(
            'MASSIVE_API_KEY (or POLYGON_API_KEY) not set. '
            'Source from .env or `export MASSIVE_API_KEY=...` first.'
        )
    return k


def _cache_path(kind: str, key: str) -> Path:
    h = hashlib.sha256(key.encode()).hexdigest()[:16]
    return CACHE_DIR / kind / f'{h}.json'


def _get_cached(kind: str, key: str) -> Optional[dict[str, Any]]:
    p = _cache_path(kind, key)
    if p.exists():
        return json.loads(p.read_text())
    return None


def _put_cached(kind: str, key: str, payload: dict[str, Any]) -> None:
    p = _cache_path(kind, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload))


def _fetch(path: str, params: Optional[dict[str, Any]] = None,
           kind: str = 'misc', cache_key: Optional[str] = None) -> dict[str, Any]:
    key = cache_key or f'{path}?{json.dumps(params or {}, sort_keys=True)}'
    cached = _get_cached(kind, key)
    if cached is not None:
        return cached

    p = dict(params or {})
    p['apiKey'] = _api_key()
    url = f'{POLYGON_BASE}{path}'
    for attempt in range(4):
        try:
            r = requests.get(url, params=p, timeout=30)
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            data = r.json()
            _put_cached(kind, key, data)
            return data
        except requests.RequestException as e:
            if attempt == 3:
                raise PolygonHistoryError(f'polygon {path}: {e}') from e
            time.sleep(2 ** attempt)
    raise PolygonHistoryError(f'polygon {path}: retries exhausted')


def chain_snapshot(underlying: str, expiry_from: str, expiry_to: str) -> list[dict[str, Any]]:
    """Return the option chain for `underlying` filtered by expiry range."""
    body = _fetch(
        f'/v3/snapshot/options/{underlying.upper()}',
        params={
            'expiration_date.gte': expiry_from,
            'expiration_date.lte': expiry_to,
            'limit': 250,
        },
        kind='chain_snapshot',
        cache_key=f'{underlying}:{expiry_from}:{expiry_to}',
    )
    return body.get('results') or []


def option_aggs(option_ticker: str, date_from: str, date_to: str) -> list[dict[str, Any]]:
    """Return 1-min aggregate bars for an option contract.

    `option_ticker` format: O:SPY250620C00450000
    """
    body = _fetch(
        f'/v2/aggs/ticker/{option_ticker}/range/1/minute/{date_from}/{date_to}',
        params={'adjusted': 'true', 'sort': 'asc', 'limit': 50000},
        kind='option_aggs',
        cache_key=f'{option_ticker}:{date_from}:{date_to}',
    )
    return body.get('results') or []


def underlying_aggs(underlying: str, date_from: str, date_to: str) -> list[dict[str, Any]]:
    body = _fetch(
        f'/v2/aggs/ticker/{underlying.upper()}/range/1/minute/{date_from}/{date_to}',
        params={'adjusted': 'true', 'sort': 'asc', 'limit': 50000},
        kind='underlying_aggs',
        cache_key=f'{underlying}:{date_from}:{date_to}',
    )
    return body.get('results') or []
