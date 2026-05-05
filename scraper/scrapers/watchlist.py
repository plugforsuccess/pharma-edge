"""Per-user watchlist scraper.

For each row in the `watchlist` table, query CT.gov / SEC EDGAR / FDA RSS
for activity matching the ticker + company. Deduplicates against
existing scanner_candidates so the same NCT id / filing isn't surfaced
on every cron run.

Each new finding is inserted as a personal scanner_candidates row with
`requested_by = user_id` so only that user sees it (RLS enforces).
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import feedparser
import requests
from supabase import Client

from .clinicaltrials import normalize_ct_date
from .market_cap import market_cap_for, stock_price_for

CTGOV = 'https://clinicaltrials.gov/api/v2/studies'
EDGAR_FTS = 'https://efts.sec.gov/LATEST/search-index'
FDA_RSS = (
    'https://www.fda.gov/about-fda/contact-fda/stay-informed/'
    'rss-feeds/press-releases/rss.xml'
)

CT_LOOKBACK_DAYS = 120  # primary completion window
EDGAR_LOOKBACK_DAYS = 14
FDA_LOOKBACK_DAYS = 30


def _sec_headers() -> dict[str, str]:
    ua = os.environ.get('SEC_USER_AGENT')
    if not ua:
        raise RuntimeError('SEC_USER_AGENT must be set for watchlist scraper')
    return {'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate'}


def _existing_nct_ids(supabase: Client, user_id: str) -> set[str]:
    """Pre-fetch NCT ids we've already surfaced for this user, so we
    don't re-create candidates the user has already reviewed/dismissed."""
    result = (
        supabase.table('scanner_candidates')
        .select('nct_id')
        .eq('requested_by', user_id)
        .not_.is_('nct_id', 'null')
        .execute()
    )
    return {row['nct_id'] for row in (result.data or []) if row.get('nct_id')}


def _existing_sec_paths(supabase: Client, user_id: str) -> set[str]:
    """SEC filings de-dup by file_path stored in raw_data->>'filing_url'."""
    result = (
        supabase.table('scanner_candidates')
        .select('raw_data')
        .eq('requested_by', user_id)
        .eq('source', 'sec_edgar')
        .execute()
    )
    out: set[str] = set()
    for row in result.data or []:
        url = (row.get('raw_data') or {}).get('filing_url')
        if url:
            out.add(url)
    return out


def _scan_ctgov(item: dict[str, Any]) -> list[dict[str, Any]]:
    company = (item.get('company_name') or '').strip()
    if not company:
        return []
    # Watchlist context: user explicitly cares about this ticker, so
    # surface anything recent including completed/terminated trials
    # where a readout may be the catalyst itself.
    end = (datetime.now(timezone.utc) + timedelta(days=CT_LOOKBACK_DAYS)).strftime('%Y-%m-%d')
    past = (datetime.now(timezone.utc) - timedelta(days=180)).strftime('%Y-%m-%d')
    # CT.gov v2 has no `filter.primaryCompletionDate` — date ranges
    # only go through `filter.advanced` using Essie syntax.
    advanced = f'AREA[PrimaryCompletionDate]RANGE[{past},{end}]'
    params = {
        'query.term': company,
        'filter.overallStatus': 'ACTIVE_NOT_RECRUITING,RECRUITING,COMPLETED,TERMINATED',
        'filter.advanced': advanced,
        # Minimum-field set — CT.gov v2 400s the whole request on a
        # single unrecognised field. WhyStopped lives at
        # protocolSection.statusModule.whyStopped; some v2 builds
        # accept it as a top-level shorthand and some don't, so we
        # read it back from the protocol path instead of requesting
        # it as its own field. Condition + InterventionName are
        # required for indication / drug_name extraction below.
        'fields': (
            'NCTId,BriefTitle,Phase,OverallStatus,'
            'PrimaryCompletionDate,EnrollmentCount,LeadSponsorName,'
            'Condition,InterventionName'
        ),
        'pageSize': 25,
        'format': 'json',
    }
    try:
        resp = requests.get(CTGOV, params=params, timeout=20)
        resp.raise_for_status()
        body = resp.json()
    except Exception as exc:
        print(f'  ctgov {item["ticker"]}: {exc}')
        return []

    hits: list[dict[str, Any]] = []
    cmp_lower = company.lower()
    for study in body.get('studies', []):
        protocol = study.get('protocolSection') or {}
        sponsor = (
            (protocol.get('sponsorCollaboratorsModule') or {})
            .get('leadSponsor', {})
            .get('name', '')
        )
        if not sponsor or cmp_lower not in sponsor.lower():
            continue
        ident = protocol.get('identificationModule') or {}
        status_module = protocol.get('statusModule') or {}
        design = protocol.get('designModule') or {}
        nct_id = ident.get('nctId')
        if not nct_id:
            continue
        phases = (design.get('phases') or [''])[0]
        # CT.gov returns 'PHASE2', 'PHASE3', etc. Strip the prefix so
        # flags read 'Phase 2' instead of 'Phase PHASE2'.
        phase_label = str(phases).replace('PHASE', '').strip() if phases else ''
        raw_completion = (status_module.get('primaryCompletionDateStruct') or {}).get('date', '')
        completion, completion_precision = normalize_ct_date(raw_completion)
        # Skip catalysts that have already passed — not actionable for
        # opening new trades. Keep current/future only; the COMPLETED
        # status filter on the API call still pulls the metadata for
        # context, but we filter by date here.
        today_iso = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        if completion and completion < today_iso:
            continue
        interventions = (
            (protocol.get('armsInterventionsModule') or {}).get('interventions') or []
        )
        drug_name = ''
        if interventions:
            drug_name = (interventions[0].get('name', '') or '').strip()
        conditions_list = (protocol.get('conditionsModule') or {}).get('conditions') or []
        indication = conditions_list[0] if conditions_list else ''
        hits.append(
            {
                'nct_id': nct_id,
                'ticker': item['ticker'],
                'company_name': company,
                'catalyst_type': 'phase3_readout' if 'PHASE3' in str(phases) else 'phase2_readout',
                'catalyst_date': completion,
                'flags': [
                    f'Phase {phase_label}' if phase_label else None,
                    f'Why stopped: {status_module["whyStopped"]}'
                    if status_module.get('whyStopped')
                    else None,
                ],
                'source': 'clinicaltrials',
                'raw_data': {
                    'sponsor': sponsor,
                    'title': ident.get('briefTitle'),
                    'drug_name': drug_name,
                    'indication': indication,
                    'enrollment': (design.get('enrollmentInfo') or {}).get('count'),
                    'overall_status': status_module.get('overallStatus'),
                    'catalyst_date_raw': raw_completion,
                    'catalyst_date_precision': completion_precision,
                },
            }
        )
    return hits


def _scan_sec(item: dict[str, Any]) -> list[dict[str, Any]]:
    ticker = item['ticker']
    company = item.get('company_name', '').strip()
    since = (datetime.now(timezone.utc) - timedelta(days=EDGAR_LOOKBACK_DAYS)).strftime('%Y-%m-%d')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    q = f'"{ticker}" OR "{company}"' if company else f'"{ticker}"'
    params = {
        'q': q,
        'dateRange': 'custom',
        'startdt': since,
        'enddt': today,
        'forms': '8-K,S-3,10-K,10-Q',
    }
    try:
        resp = requests.get(EDGAR_FTS, params=params, headers=_sec_headers(), timeout=20)
        resp.raise_for_status()
        body = resp.json()
    except Exception as exc:
        print(f'  sec {ticker}: {exc}')
        return []

    hits: list[dict[str, Any]] = []
    company_lower = (company or '').lower()
    for hit in body.get('hits', {}).get('hits', [])[:10]:
        src = hit.get('_source') or {}
        tickers = [t.upper() for t in (src.get('tickers') or [])]
        entity_name = str(src.get('entity_name') or '').lower()
        # Match if SEC returned the ticker explicitly OR the entity
        # name contains the company we're tracking. SEC FTS sometimes
        # omits the tickers array entirely; without this fallback we'd
        # silently miss every filing.
        ticker_match = ticker in tickers
        company_match = bool(company_lower) and company_lower in entity_name
        if not ticker_match and not company_match:
            continue
        file_path = src.get('file_path', '')
        if not file_path:
            continue
        url = f'https://www.sec.gov/Archives/edgar/{file_path}'
        form_type = src.get('form_type', '8-K')
        hits.append(
            {
                'nct_id': None,
                'ticker': ticker,
                'company_name': company or src.get('entity_name', ''),
                'catalyst_type': 'other',
                'catalyst_date': src.get('file_date', ''),
                'flags': [f'Recent {form_type} filing'],
                'source': 'sec_edgar',
                'raw_data': {
                    'form_type': form_type,
                    'file_date': src.get('file_date'),
                    'filing_url': url,
                    'entity_name': src.get('entity_name'),
                    'period_of_report': src.get('period_of_report'),
                },
            }
        )
    return hits


def _scan_fda(item: dict[str, Any]) -> list[dict[str, Any]]:
    ticker_lower = item['ticker'].lower()
    company_lower = (item.get('company_name') or '').lower()
    cutoff = datetime.now(timezone.utc) - timedelta(days=FDA_LOOKBACK_DAYS)

    try:
        feed = feedparser.parse(FDA_RSS)
    except Exception as exc:
        print(f'  fda {item["ticker"]}: {exc}')
        return []

    hits: list[dict[str, Any]] = []
    for entry in getattr(feed, 'entries', []):
        published_parsed = getattr(entry, 'published_parsed', None)
        if not published_parsed:
            continue
        published = datetime(*published_parsed[:6], tzinfo=timezone.utc)
        if published < cutoff:
            continue
        haystack = f'{entry.get("title", "")} {entry.get("summary", "")}'.lower()
        if ticker_lower not in haystack and (
            not company_lower or company_lower not in haystack
        ):
            continue
        hits.append(
            {
                'nct_id': None,
                'ticker': item['ticker'],
                'company_name': item.get('company_name', ''),
                'catalyst_type': 'other',
                'catalyst_date': published.strftime('%Y-%m-%d'),
                'flags': ['FDA press release'],
                'source': 'fda_calendar',
                'raw_data': {
                    'title': entry.get('title'),
                    'link': entry.get('link'),
                    'published': published.isoformat(),
                    'summary': entry.get('summary', ''),
                },
            }
        )
        if len(hits) >= 3:
            break
    return hits


def scan_watchlist(supabase: Client) -> dict[str, int]:
    """Scrape each user's watchlist; insert new candidates with
    requested_by set. Returns counts of new candidates per source."""
    result = supabase.table('watchlist').select('user_id, ticker, company_name').execute()
    rows = result.data or []
    print(f'  {len(rows)} watchlist rows across all users')

    by_user: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_user.setdefault(row['user_id'], []).append(row)

    counts = {'clinicaltrials': 0, 'sec_edgar': 0, 'fda_calendar': 0}

    for user_id, items in by_user.items():
        seen_nct = _existing_nct_ids(supabase, user_id)
        seen_sec = _existing_sec_paths(supabase, user_id)

        for item in items:
            ct_hits = _scan_ctgov(item)
            sec_hits = _scan_sec(item)
            fda_hits = _scan_fda(item)
            time.sleep(0.5)  # be polite to the upstream APIs

            for hit in ct_hits:
                if hit['nct_id'] in seen_nct:
                    continue
                seen_nct.add(hit['nct_id'])
                _insert(supabase, user_id, hit)
                counts['clinicaltrials'] += 1
            for hit in sec_hits:
                url = hit['raw_data'].get('filing_url')
                if url in seen_sec:
                    continue
                if url:
                    seen_sec.add(url)
                _insert(supabase, user_id, hit)
                counts['sec_edgar'] += 1
            for hit in fda_hits:
                _insert(supabase, user_id, hit)
                counts['fda_calendar'] += 1

    return counts


def _insert(supabase: Client, user_id: str, hit: dict[str, Any]) -> None:
    flags = [f for f in (hit.get('flags') or []) if f]
    raw_data = dict(hit.get('raw_data') or {})
    raw_data.setdefault('stock_price', stock_price_for(hit['ticker']))
    payload = {
        'ticker': hit['ticker'],
        'company_name': hit['company_name'],
        'catalyst_type': hit['catalyst_type'],
        'catalyst_date': hit.get('catalyst_date') or None,
        'score': 6,  # watchlist hits get a baseline mid score
        'flags': flags,
        'source': hit['source'],
        'nct_id': hit.get('nct_id'),
        'market_cap': market_cap_for(hit['ticker']),
        'raw_data': raw_data,
        'requested_by': user_id,
    }
    try:
        supabase.table('scanner_candidates').insert(payload).execute()
    except Exception as exc:
        # Likely the dedup unique-index firing — safe to swallow.
        print(f'  insert skip ({hit["ticker"]} {hit.get("nct_id") or hit["source"]}): {exc}')
