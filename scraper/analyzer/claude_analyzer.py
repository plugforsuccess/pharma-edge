"""Claude Sonnet 4.6 analysis of scanner candidates and the daily digest.

Robust JSON extraction (strip fences + take outermost {...}) mirrors the
edge function's parser so prompt drift in either place stays survivable.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import anthropic

CLAUDE_MODEL = "claude-sonnet-4-6"
ANALYSIS_MAX_TOKENS = 1500
DIGEST_MAX_TOKENS = 600


def _client() -> anthropic.Anthropic:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=key)


def _extract_json(text: str) -> dict[str, Any]:
    stripped = re.sub(r"```json|```", "", text).strip()
    first = stripped.find("{")
    last = stripped.rfind("}")
    if first == -1 or last == -1 or last <= first:
        raise ValueError("no JSON object in Claude response")
    return json.loads(stripped[first : last + 1])


def _first_text_block(message: anthropic.types.Message) -> str:
    for block in message.content:
        if getattr(block, "type", None) == "text":
            return getattr(block, "text", "") or ""
    return ""


def analyze_scanner_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    """Preliminary thesis + flags. Returns a fallback dict on failure rather
    than raising so a single bad candidate doesn't poison the run."""
    prompt = f"""You are analyzing a biotech/pharma catalyst candidate detected by an automated scanner.

Candidate Data:
{json.dumps(candidate, indent=2, default=str)}

Based on this data, provide a preliminary analysis. Return ONLY valid JSON:
{{
  "preliminary_thesis": "2-3 sentence initial read based on available data",
  "red_flags": ["list of specific red flags from the data"],
  "requires_human_review": true/false,
  "priority_score": <1-10, how urgently should this be reviewed>,
  "suggested_direction": "long_put" | "long_call" | "watch",
  "data_gaps": ["what additional information would improve confidence"],
  "catalyst_date_confidence": "high" | "medium" | "low"
}}"""

    try:
        message = _client().messages.create(
            model=CLAUDE_MODEL,
            max_tokens=ANALYSIS_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        if message.stop_reason and message.stop_reason != "end_turn":
            return _failed_analysis(
                f"truncated (stop_reason={message.stop_reason})"
            )
        return _extract_json(_first_text_block(message))
    except Exception as exc:
        return _failed_analysis(str(exc))


def _failed_analysis(reason: str) -> dict[str, Any]:
    return {
        "preliminary_thesis": f"Analysis failed — requires manual review ({reason})",
        "requires_human_review": True,
        "priority_score": 5,
        "error": reason,
    }


def generate_daily_digest(
    candidates: list[dict[str, Any]],
    fda_events: list[dict[str, Any]],
    sec_events: list[dict[str, Any]],
) -> str:
    prompt = f"""Generate a concise daily digest for a biotech options trader.

Scanner Results:
- New trial candidates: {len(candidates)}
- FDA events today: {len(fda_events)}
- Notable SEC filings: {len(sec_events)}

Top Candidates:
{json.dumps(candidates[:5], indent=2, default=str)}

FDA Events:
{json.dumps(fda_events[:3], indent=2, default=str)}

Write a 200-word professional digest. Lead with the most actionable items.
No markdown. Plain text only."""

    try:
        message = _client().messages.create(
            model=CLAUDE_MODEL,
            max_tokens=DIGEST_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        text = _first_text_block(message)
        if text:
            return text
    except Exception as exc:
        print(f"  generate_daily_digest: {exc}")

    return (
        f"Daily scan complete. {len(candidates)} candidates, "
        f"{len(fda_events)} FDA events, {len(sec_events)} SEC filings. "
        "Open the app to review."
    )
