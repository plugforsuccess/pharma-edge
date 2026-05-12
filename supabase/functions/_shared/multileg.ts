// Multi-leg order construction for Tastytrade.
//
// Supports 2-leg (verticals) and 4-leg (iron condor / butterfly)
// debit + credit structures. The Tastytrade order API accepts an
// array of leg objects with `action` ∈ {Buy to Open, Sell to Open,
// Buy to Close, Sell to Close} and a single price-effect for the
// net package (Debit or Credit).
//
// Structures supported:
//   * BULL_CALL / BEAR_PUT                    — 2-leg debit verticals
//   * BULL_PUT_CREDIT / BEAR_CALL_CREDIT      — 2-leg credit verticals
//   * short_iron_condor / earnings_iron_condor / opex_iron_condor
//                                              — 4-leg credit IC
//   * earnings_iron_butterfly / opex_iron_butterfly
//                                              — 4-leg credit ironfly
//   * short_strangle                          — 2-leg credit (sell P + sell C, no wings)
//   * short_put_credit / short_call_credit    — 2-leg credit verticals (same as BULL_PUT etc)
//
// Naming convention for 4-leg legs:
//   long_put < short_put < short_call < long_call
//
// The caller passes a `MultilegStructure` and we emit the Tastytrade
// legs array. Strike inputs are validated for ordering invariants.

import { buildOccSymbol } from './tastytrade.ts'

export type StructureKind =
  | 'BULL_CALL' | 'BEAR_PUT'
  | 'BULL_PUT_CREDIT' | 'BEAR_CALL_CREDIT'
  | 'short_iron_condor' | 'earnings_iron_condor' | 'opex_iron_condor'
  | 'earnings_iron_butterfly' | 'opex_iron_butterfly'
  | 'short_strangle'
  | 'short_put_credit' | 'short_call_credit'

export interface MultilegStructure {
  kind: StructureKind
  ticker: string
  expiry: string  // YYYY-MM-DD
  long_put_strike?:  number
  short_put_strike?: number
  short_call_strike?: number
  long_call_strike?: number
  // 2-leg verticals can use the simpler {long_strike, short_strike} form
  // for backward compatibility — we map them to the 4-leg fields by kind.
  long_strike?: number
  short_strike?: number
}

export interface TastytradeLeg {
  'instrument-type': 'Equity Option'
  symbol: string
  quantity: number
  action: 'Buy to Open' | 'Sell to Open' | 'Buy to Close' | 'Sell to Close'
}

function assertOrdered(label: string, strikes: number[]): void {
  for (let i = 1; i < strikes.length; i++) {
    if (!(strikes[i] > strikes[i - 1])) {
      throw new Error(`${label}: strikes must be strictly ascending, got ${JSON.stringify(strikes)}`)
    }
  }
}

// Build the legs for an OPENING order. `closing=true` flips actions
// (Buy to Close / Sell to Close) for an exit.
export function buildLegs(
  s: MultilegStructure,
  contracts: number,
  closing = false,
): { legs: TastytradeLeg[]; priceEffect: 'Debit' | 'Credit' } {
  const occ = (type: 'P' | 'C', strike: number) =>
    buildOccSymbol(s.ticker, s.expiry, type, strike)

  const open: (kind: 'long' | 'short') => 'Buy to Open' | 'Sell to Open' =
    (k) => k === 'long' ? 'Buy to Open' : 'Sell to Open'
  const close: (kind: 'long' | 'short') => 'Buy to Close' | 'Sell to Close' =
    (k) => k === 'long' ? 'Sell to Close' : 'Buy to Close'
  const act = closing ? close : open

  const q = contracts

  switch (s.kind) {
    case 'BULL_CALL': {
      const lo = num(s.long_strike, 'long_strike')
      const hi = num(s.short_strike, 'short_strike')
      assertOrdered('BULL_CALL', [lo, hi])
      return {
        priceEffect: closing ? 'Credit' : 'Debit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('C', lo), quantity: q, action: act('long') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', hi), quantity: q, action: act('short') },
        ],
      }
    }
    case 'BEAR_PUT': {
      const hi = num(s.long_strike, 'long_strike')
      const lo = num(s.short_strike, 'short_strike')
      assertOrdered('BEAR_PUT', [lo, hi])
      return {
        priceEffect: closing ? 'Credit' : 'Debit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('P', hi), quantity: q, action: act('long') },
          { 'instrument-type': 'Equity Option', symbol: occ('P', lo), quantity: q, action: act('short') },
        ],
      }
    }
    case 'BULL_PUT_CREDIT':
    case 'short_put_credit': {
      // Sell higher-strike put, buy lower-strike put → credit
      const shortK = num(s.short_strike ?? s.short_put_strike, 'short_put_strike')
      const longK  = num(s.long_strike  ?? s.long_put_strike,  'long_put_strike')
      assertOrdered('BULL_PUT_CREDIT', [longK, shortK])
      return {
        priceEffect: closing ? 'Debit' : 'Credit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('P', longK),  quantity: q, action: act('long')  },
          { 'instrument-type': 'Equity Option', symbol: occ('P', shortK), quantity: q, action: act('short') },
        ],
      }
    }
    case 'BEAR_CALL_CREDIT':
    case 'short_call_credit': {
      // Sell lower-strike call, buy higher-strike call → credit
      const shortK = num(s.short_strike ?? s.short_call_strike, 'short_call_strike')
      const longK  = num(s.long_strike  ?? s.long_call_strike,  'long_call_strike')
      assertOrdered('BEAR_CALL_CREDIT', [shortK, longK])
      return {
        priceEffect: closing ? 'Debit' : 'Credit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('C', shortK), quantity: q, action: act('short') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', longK),  quantity: q, action: act('long')  },
        ],
      }
    }
    case 'short_iron_condor':
    case 'earnings_iron_condor':
    case 'opex_iron_condor': {
      const longP  = num(s.long_put_strike,  'long_put_strike')
      const shortP = num(s.short_put_strike, 'short_put_strike')
      const shortC = num(s.short_call_strike, 'short_call_strike')
      const longC  = num(s.long_call_strike,  'long_call_strike')
      assertOrdered('iron_condor', [longP, shortP, shortC, longC])
      return {
        priceEffect: closing ? 'Debit' : 'Credit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('P', longP),  quantity: q, action: act('long')  },
          { 'instrument-type': 'Equity Option', symbol: occ('P', shortP), quantity: q, action: act('short') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', shortC), quantity: q, action: act('short') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', longC),  quantity: q, action: act('long')  },
        ],
      }
    }
    case 'earnings_iron_butterfly':
    case 'opex_iron_butterfly': {
      // short_put_strike == short_call_strike (ATM body)
      const longP  = num(s.long_put_strike,  'long_put_strike')
      const body   = num(s.short_put_strike, 'short_put_strike')
      const bodyC  = num(s.short_call_strike, 'short_call_strike')
      const longC  = num(s.long_call_strike,  'long_call_strike')
      if (body !== bodyC) {
        throw new Error(`iron_butterfly requires short_put_strike == short_call_strike, got ${body} vs ${bodyC}`)
      }
      assertOrdered('iron_butterfly', [longP, body, longC])
      return {
        priceEffect: closing ? 'Debit' : 'Credit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('P', longP), quantity: q, action: act('long')  },
          { 'instrument-type': 'Equity Option', symbol: occ('P', body),  quantity: q, action: act('short') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', body),  quantity: q, action: act('short') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', longC), quantity: q, action: act('long')  },
        ],
      }
    }
    case 'short_strangle': {
      const shortP = num(s.short_put_strike, 'short_put_strike')
      const shortC = num(s.short_call_strike, 'short_call_strike')
      assertOrdered('short_strangle', [shortP, shortC])
      return {
        priceEffect: closing ? 'Debit' : 'Credit',
        legs: [
          { 'instrument-type': 'Equity Option', symbol: occ('P', shortP), quantity: q, action: act('short') },
          { 'instrument-type': 'Equity Option', symbol: occ('C', shortC), quantity: q, action: act('short') },
        ],
      }
    }
  }
}

function num(v: unknown, label: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number, got ${JSON.stringify(v)}`)
  }
  return n
}

// Sanity check on a debit/credit price for a structure: the absolute
// price must be ≤ total max risk and > 0. Caller passes max_risk_per_lot
// computed from strike widths.
export function validatePrice(
  priceEffect: 'Debit' | 'Credit',
  price: number,
  maxRiskPerLot: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: 'price must be positive' }
  }
  if (price > maxRiskPerLot) {
    return { ok: false, reason: `price ${price.toFixed(2)} > max_risk_per_lot ${maxRiskPerLot.toFixed(2)}` }
  }
  return { ok: true }
}
