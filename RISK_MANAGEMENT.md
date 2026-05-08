# RISK_MANAGEMENT.md — Cash Moves

> Personal trading discipline that sits on top of the app-enforced rules
> in CLAUDE.md. The app prevents you from logging rule-violating trades.
> It cannot prevent you from oversizing, holding too long, revenge-trading,
> or skipping the journal. Those are on you. This doc is the framework.
>
> **Read this end-to-end once. Re-read it on the 1st of every month.
> Edit it the way you'd edit a constitution: rarely, only after evidence
> supports the change, never to relax a rule that just felt restrictive
> on a single trade.**

---

## Why these rules exist

Risk management is the only durable edge. Strategy edges erode, regimes
change, single theses fail. What survives across years is **position
sizing discipline + mechanical exits + journal compliance**. Skip any
of these and the math turns negative regardless of how good your reads
are.

The Cash Moves immutable record (hash-anchored signals + outcomes) is
the *receipt* that proves your edge over time. The receipt is worthless
if the trades behind it weren't sized, exited, and logged with discipline.

---

## The two layers

| Layer | Enforced by | What it catches |
|---|---|---|
| **Structural** | App code (calculator, suggester filter, pre-trade checklist) | Bad structures, bad sizing math, missing checklist items |
| **Behavioral** | This document, your habit | Holding too long, revenge trading, size creep, journal skipping |

The structural layer prevents you from logging a 1:0.5 R/R credit spread
or a sub-21-DTE entry. The behavioral layer prevents you from holding a
1:3 R/R debit through expiration and watching gamma destroy it. Both
must hold.

### Layer 1 (structural) — already in CLAUDE.md and the app

| Rule | Enforcement |
|---|---|
| 2% account-size sizing per options trade | Pre-trade checklist + suggester sizer |
| 1% per Kalshi position | Position-sizing component |
| 1:1.5 R/R minimum (1:2 target) | Strike calculator + suggester filter |
| Min 21 DTE on entry | Pre-trade checklist |
| Spreads only — no naked options | Calculator structure list |
| Min 2 confirmed signals before entry | Pre-trade checklist |
| 30–45 days past any catalyst | Calculator catalyst-DTE warning |
| Stop loss at -50% on options | Stop-loss component, embedded checklist |
| Max 20% biotech sector exposure | Manual track |

### Layer 2 (behavioral) — this document

| Rule | What it prevents |
|---|---|
| Bracket order on every trade, before walking away | Manual override under pressure |
| Profit target = 50% of max profit (default) | Holding too long, gamma whipsaw at expiration |
| Stop loss = 50% of debit (default) | Letting losers compound |
| Never hold to expiration | Pin risk, gamma cliff, theta cliff |
| Max 5 concurrent open trades | Correlation risk concentration |
| No new trades after a max-loss exit (same session) | Revenge trading |
| Size by rule, not by feeling | Size creep on win streaks |
| Trail stops only on 21+ DTE, pre-committed tiers only | Reactive in-flight overrides |
| Monthly rule-compliance review | Drift from process |

---

## Position sizing — the foundation

The 2% rule is non-negotiable. Maximum 2% of account at risk per trade.

### Why 2% specifically

```
At 2% per trade:
  10 consecutive max losses = -18% drawdown   (recoverable)

At 5% per trade:
  10 consecutive max losses = -40% drawdown   (career-threatening)

At 10% per trade:
  5 consecutive max losses  = -41% drawdown   (account dead)
```

A 60% win-rate strategy will hit 5+ consecutive losses ~3% of the time —
roughly once a year. Position sizing must survive that streak. The 2%
rule is survival math, not conservatism.

### Sizing formula

```
max_contracts = floor((account_size × 0.02) / max_loss_per_contract)
```

Examples:

| Account | Max loss/contract | Max contracts |
|---|---|---|
| $10,000 | $200 | 1 |
| $25,000 | $200 | 2 |
| $50,000 | $200 | 5 |
| $100,000 | $200 | 10 |
| $250,000 | $200 | 25 |

If `max_contracts == 0`, the trade is too expensive for the account.
Skip it or find a tighter spread. **Do not enter the trade by violating
the rule.** That's the failure mode the rule was written to prevent.

---

## Profit taking

### Standard rule: 50% of max profit

For every debit spread, set a GTC profit target at:

```
target_close_price = (max_profit × 0.50) + entry_debit
                   = (width − debit) × 0.50 + debit
```

Worked example for a $15-wide bull call paid $3.71 debit:

```
max_profit  = $15.00 − $3.71  = $11.29
50% of max  = $11.29 × 0.50   = $5.65
target close = $5.65 + $3.71  = $9.36
```

If the spread mark hits $9.36, the GTC fires and you exit with +$565
profit per contract.

### Why 50%, not higher or lower

Tastytrade's published research on tens of thousands of trades found 50%
of max profit is the sweet spot for debit spreads:

- Win rate increases from ~50% to ~70% (you exit before late reversals)
- ~30% of theoretical max profit given up
- Capital frees earlier for redeployment
- Avoids gamma + theta cliff at expiration

| Target | Win rate to break even | When to use |
|---|---|---|
| 25% of max | 57% | Short-DTE, fast capture |
| **50% of max** | **40%** | **Default — every trade** |
| 75% of max | 31% | High conviction, deep ITM, 21+ DTE only |
| 100% (max) | 25% | Never — forces holding to expiration |

### Below 50% is mathematically a losing strategy

Walking away with $30 on a $371 max loss requires a 92% win rate to
break even. No retail trader sustains 92%. Small wins do not compensate
for inevitable max losses. **Do not normalize sub-50% profit-taking
"to be safe."** It is the opposite of safe.

The breakeven win-rate formula:

```
breakeven_win_rate = avg_loss / (avg_loss + avg_win)
```

Apply to any "I'll just take a quick gain" instinct before acting on it.

---

## Stop loss

### Standard rule: 50% of debit paid

For every debit spread, set a GTC stop at:

```
stop_price = entry_debit × 0.50
```

Worked example for $3.71 debit: stop at $1.85. If spread mark hits $1.85,
GTC fires and you exit with -$186 per contract.

### Bracket setup

The 50%-target / 50%-stop combo is delivered as an OCO (one-cancels-the-
other) bracket order. Both orders sit GTC. If either fires, the other
auto-cancels.

This is the single most important behavioral rule: **bracket on every
trade, before you walk away from the platform**. No exceptions.

### Above-breakeven stops (manual ratchets)

When a 21+ DTE trade is in profit, the stop can migrate upward to lock
in gains. This is the manual trailing stop. **Only valid if pre-committed
in writing before entry.**

For a 21+ DTE bull call / bear put, use a 3-tier ratchet:

```
Tier 0 (entry):           Stop at 50% of debit       (initial protection)
Tier 1 (spread = $X):     Cancel bracket, raise stop (lock 50% of unrealized)
Tier 2 (spread = $Y):     Cancel bracket, raise stop (lock 75% of unrealized)
Tier 3 (target hit):      Auto-exit at target        (full +50% of max)
```

X and Y are written down as specific dollar levels before entry. **Do
not adjust the ratchet reactively.** If the spread hasn't crossed a
threshold, don't touch the bracket. If it has, execute the next tier
without deliberation. The moment you find yourself thinking "should I
ratchet now?" — that's an emotional override; the answer is "do what
the table says."

### Do NOT trail short-DTE trades

For trades with <21 DTE remaining, trailing causes more whipsaw than it
prevents. Theta acceleration and intraday volatility on short-dated
options will stop you out at the wrong moment. Use static bracket only.
Capture 50% target or hit 50% stop, no in-between management.

---

## Expiration management

### Never hold a debit spread to expiration

Five risks compound on expiration day:

1. **Gamma whipsaw.** Last 2 hours: a 0.3% underlying move = $300+
   spread P/L swing. Variance amplifier.
2. **Theta cliff.** Final 24h: spread value collapses regardless of
   direction. You bleed by sitting still.
3. **Pin risk.** Closing at or near the short strike triggers assignment
   overnight. You wake up with unwanted stock and gap risk.
4. **Liquidity widening.** Bid/ask blows out 5–10¢ in the final hour.
   Fills are noticeably worse than mid.
5. **Single-tick variance.** $725.01 = max profit. $724.99 = nothing.
   One tick determines outcome. That is not a trade — it's a coin flip.

Holding to expiration converts your edge into pure variance. Exit before.

### Expiration-day timing hierarchy

```
9:30 – 11:00am    Safe close zone
11:00 – 12:00pm   Comfortable
12:00 – 1:00pm    Acceptable
1:00 – 2:00pm     Acceptable cutoff (hard deadline)
2:00 – 3:00pm     Avoid
3:00 – 3:30pm     Dangerous
3:30 – 4:00pm     Do not hold

Extended hours:    Never. Liquidity is thin, fills are bad, no edge.
```

### Standard exit hierarchy

```
PRIMARY:     Exit when bracket profit-target or stop fires
             (whatever time that is, including before expiration day)

BACKUP 1:    If still alive on expiration day, close manually by 11am

BACKUP 2:    2pm hard deadline — close at market regardless of P&L

NEVER:       Hold past 2pm on expiration day
NEVER:       Hold to the bell expecting auto-exercise to handle it
```

The 2pm rule is your **deadline**, not your **plan**. Plan to be out by
mid-morning. 2pm is the line you don't cross.

---

## Behavioral guardrails

### No revenge trading

After a max-loss exit, no new trades for the rest of the session.
Walk away from the platform. Cooldown is mandatory. Most account
blow-ups happen in the 60 minutes after a max loss, when the trader
"makes it back" by oversizing the next trade.

### No size creep on streaks

After 3 consecutive winners, do not increase position size. Variance,
not edge, drove the streak. The next trade is statistically the same
as the first. Size creep on tilt-from-success destroys more accounts
than tilt-from-loss.

### Max 5 concurrent open trades

Beyond 5 open positions, portfolio risk concentrates in ways that are
hard to see. Eight "tech goes up" trades expressed differently are still
one trade. A regime change kills 8 positions at once. Cap at 5.

### Bracket on every trade, before walking away

Profit target + stop loss, both GTC, both set the moment the trade opens.
Verify the order is working (Working Orders tab) before closing the app.
Do not trust yourself to manage manually under pressure — pressure is
when you fail.

### One-bracket-per-trade rule

Do not run multiple overlapping orders on the same position. If you need
to ratchet the stop, *cancel the existing bracket first*, then create
the new one. Multiple orders on the same legs will fight each other and
can result in partial fills or duplicate closes.

---

## The math at a glance

The breakeven win rate for a given profit/loss combo:

```
breakeven_win_rate = avg_loss / (avg_loss + avg_win)
```

Reference table for a typical $371 max-loss debit spread:

| Avg profit captured | R/R achieved | Win rate to break even |
|---|---|---|
| $30 | 1:0.08 | 92.5% — impossible |
| $100 | 1:0.27 | 79% — unsustainable |
| $185 (50% of debit) | 1:0.50 | 67% — unrealistic |
| $282 (25% of max) | 1:0.76 | 57% — possible |
| $371 (full debit gain) | 1:1.00 | 50% — coin flip |
| **$565 (50% of max)** | **1:1.52** | **40% — comfortable** |
| $847 (75% of max) | 1:2.28 | 31% — very forgiving |

The standard 50%-target / 50%-stop bracket gives an effective 1:3 R/R
on win:loss outcomes (because target captures 50% of $11.29 = $565,
stop limits loss to 50% of $3.71 = $186, and $565/$186 ≈ 3:1). At 1:3,
you only need a **25% win rate** to be profitable. That math is what
makes scaling possible.

---

## Career arc to "trading for a living"

```
Phase 1 — Months 0–6
  Paper trade or trade tiny size.
  100% rule compliance, ignore P&L.
  Goal: build the habit, not the account.

Phase 2 — Months 6–18
  Real money, 2% sizing strict.
  Log every outcome, hash-anchor every trade.
  100+ logged trades through this phase.
  Goal: demonstrate edge through track record, not income.

Phase 3 — Months 18–36
  Scale sizing to 2% of growing account.
  Side income emerges.
  Account growth from compounding + monthly contributions.
  Goal: account size 3× starting capital.

Phase 4 — Year 3+
  Decision: full-time or keep compounding.
  Don't force the timeline.
```

**Skipping phases is the most common cause of blow-ups.** Most "live
off trading" stories that fail did so by jumping from Phase 1 to Phase 4
in 6 months on a winning streak. The streak was variance, not edge.
The Phase 2 discipline never got built. The first real drawdown ended
the run.

---

## The math of replacement income

To replace, e.g., $80k/year salary (~$110k gross including taxes):

| Annual return assumption | Account needed |
|---|---|
| 50% (Renaissance-tier, unrealistic) | $220k |
| 30% (excellent, top 5%) | $370k |
| 20% (very good for retail) | $550k |
| 10% (more realistic baseline) | $1.1M |

Plan for 20–30% annualized at best. Anything higher is variance, fraud,
or survivor bias.

**The path to "trading for a living" requires capital first, then
deployment — not the reverse.** Nobody trades a $5k account into a
living. They trade a $5k account into a $25k account, then $25k into
$100k, etc., over years. The first phase of the journey is capital
accumulation through compounding + outside income, not trading-as-
income.

---

## Daily / weekly / monthly rituals

### Per trade (every entry)
- [ ] Pre-trade checklist (10 items)
- [ ] R/R verified via calculator (40% / 60% rule passes)
- [ ] 21+ DTE confirmed
- [ ] 2% sizing verified
- [ ] OCO bracket set (profit target + stop) BEFORE walking away
- [ ] Hash anchored on log

### Daily
- [ ] If max-loss exit hit: no more trades, end session
- [ ] If 5 concurrent open positions: do not enter new trade
- [ ] Any trade approaching expiration day: confirm exit plan in writing

### Weekly
- [ ] Review open positions: any near expiration that need management?
- [ ] Note rule compliance per trade (binary: did all rules hold?)

### Monthly (1st of each month)
- [ ] Pull 30 days of outcomes from the immutable record
- [ ] Calculate: total trades, win rate, average R/R achieved
- [ ] Calculate: rule compliance rate (% of trades that followed all rules)
- [ ] If rule compliance <90%: stay in current Phase, do not scale sizing
- [ ] If rule compliance ≥90% AND win rate ≥40%: review for next-phase scaling
- [ ] Re-read this document end-to-end

---

## What this document is not

- **Not a strategy guide.** The app's GEX-driven setups + scanner are
  the strategy. This is risk management on top of strategy.
- **Not a guarantee of profit.** Even with perfect rule compliance,
  variance can produce losing months and quarters. The rules don't
  prevent losses; they prevent ruin.
- **Not advice for unverified hot tips.** The track-record + hash-
  anchoring infrastructure is what makes the rules meaningful. Without
  the receipt, the rules are just opinions.

---

## Owner

Cameron Wiley

Updates require deliberate consideration. Edit the rule book the way
you'd edit a constitution: rarely, after evidence supports the change,
never to relax a rule that just felt restrictive on a single trade.

---

*Last updated: 2026-05-08*
*See also: CLAUDE.md (project overview, app-enforced rules), src/pages/Rules.jsx (in-app summary)*
