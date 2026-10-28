# Top Forming, job 1: results

Run 40763271904, 2026-10-28, rules `prereg-2026-10-28` (PREREG.md,
committed 7a2e831 before any code or data). Survivors only.

## Verdict

**Both stage policies pass the pre-registered mark, but the pass doesn't
mean what it was meant to.** The gain is small and identical on random
entry days. The stage policies also end with a lower average return than
the plain 25% trail. Holding beat every trailing policy on the average
and the median.

| Graded test, vs the 25% trail | Mean diff in captured | 97.5% interval | Folds positive | Doublers sold early | Verdict |
|---|---|---|---|---|---|
| Stage trail | +0.9 pts | +0.4 to +1.5 | 82% of 17 | +2.7 pts | PASS |
| ⅓ / ⅓ / runner + stage trail | +2.2 pts | +1.3 to +3.1 | 88% of 17 | +2.7 pts | PASS |
| *Same test on random entry days* | *+0.9 / +2.1 pts* | | | | *not graded* |

The pre-registration said: "if the stage policies help as much on random
days, the stages aren't what's helping." They help exactly as much. So
the gain doesn't come from catching the moment a holder is up 50%. A
trail that tightens after a stock gets extended helps the same amount
anywhere. Whether the stage timing matters, or any tighter trail would do
as well, was not tested.

## The policies

13,064 run-up entries (a holder up 50%+ from a 60-session low), 2018 →
mid-2026. 10,100 had a peak gain of 10% or more within 120 sessions, and
3,909 went on to double within 252 sessions.

| Policy | Captured (mean) | Final avg | Final median | Give-back | Worst | 5th pct | Doublers sold early |
|---|---|---|---|---|---|---|---|
| Buy-and-hold | −5.9% | **+16.7%** | **−0.2%** | 52.0% | −100% | −65% | 44% |
| 25% trail | −6.7% | +8.2% | −8.7% | 66.3% | −99% | −31% | 67% |
| ⅓ / ⅓ / runner | −5.2% | +7.4% | −8.6% | 67.3% | −99% | −31% | 67% |
| Stage trail | −5.8% | +7.5% | −8.2% | 67.3% | −99% | −30% | 70% |
| ⅓ / ⅓ / runner + stage trail | **−4.5%** | +7.0% | −8.1% | 68.0% | −99% | −30% | 70% |

Random-day control, 13,010 entries:

| Policy | Captured | Final avg | Final median |
|---|---|---|---|
| Buy-and-hold | −14.3% | +11.2% | −4.2% |
| 25% trail | −11.3% | +5.3% | −10.4% |
| ⅓ / ⅓ / runner + stage trail | −9.2% | +4.7% | −9.9% |

**Reading.**
- **The two measures disagree.** "Captured" is the mean of return ÷ peak
  gain, so it weighs trades with small peaks heavily. The stage policies
  win on it by 1–2 points. On final return they lose to the 25% trail
  (+7.0–7.5% vs +8.2%), because they sell more of the doublers early
  (70% vs 67%).
- **Every trailing stop gives up half the average return.** Holding made
  +16.7% on average. The trails made +7–8%, and their median is about
  −8% against holding's −0.2%.
- **What the trails buy is the tail.** The 5th percentile goes from −65%
  holding to −30% with any trail. A 2,554-of-5,694 survivorship gap (45%)
  sits on exactly that tail: the names that went to zero are missing,
  and they would have made holding look worse. So the hold-vs-trail gap
  is overstated, by an amount we can't size without delisted prices.
- **Gaps get through.** Every trail's worst trade is −99%, a gap down
  through the stop.

## Stage validation (reported, not graded)

Top event: a close 30% under close(t) within 60 sessions, before any
close 10% above it. Base rate 11.6% of 2,740,311 eligible stock-days.

| Stage | Stock-days | Hit rate | Share of all top events | Lift | Median sessions to the trough |
|---|---|---|---|---|---|
| Clear | 2,705,936 | 11.4% | 97.2% | 0.98× | — |
| Extended | 24,734 | 23.1% | 1.8% | **1.99×** | 43 |
| Distribution | 238 | 32.8% | 0.0% | **2.83×** | 46.5 |
| Trend broken | 9,403 | 32.1% | 1.0% | **2.77×** | 48 |

Every stage clears the 1.5× bar. But the stages are rare: 97% of top
events happen while the stock reads Clear. Distribution fired on only
238 stock-days in 8½ years across 3,487 stocks. With C not built, the
score is renormalized over A, B and E, and the B group's average of five
signals rarely reaches its threshold.

Calibration rises steadily with the score: 9.6% at 0–9, 12.8% at 30–39,
22.6% at 50–59, 34.0% at 60–69. So the score orders risk, but it is not
a probability and must not be shown as one.

| Signal | Lift | Signal | Lift |
|---|---|---|---|
| B4 exhaustion gap | **2.31×** | E3 failed retest | 1.21× |
| A1 extension | **1.77×** | E2 weekly breakdown | 1.06× |
| B1 climax volume | 1.35× | A3 volatility | 1.04× |
| E1 trend break | 1.26× | B5 lower highs | 1.04× |
| | | A2 parabolic · B2 distribution days · B3 divergence | 0.96–0.98× |

Six of the eleven signals are noise at lift 1.06× or under: A2, A3, B2,
B3, B5 and E2. They dilute their groups' averages, which is part of why
the stages fire so rarely.

## Case studies

Charts are in the run's artifact (`out/*.svg`).

- **AEVA** read Extended at $30.00 on Jul 8, 2025, flickered, and was
  back to Clear at $13.76 by Aug 6. It never reached Distribution or
  Trend broken. The round trip was flagged only as Extended.
- **AIRJ** read Extended at $29.27 on Mar 11, 2024, for two days, then
  Clear at $18.38. Nothing else fired.
- **RXRX** and **NAUT** read Extended for a day or a week several times,
  and never higher.
- **GME, 2021:** Extended at $46.74, then **Trend broken** twice in April
  2021. The only case study to reach the confirming stage.
- **DJT, MSTR:** Extended on and off for weeks through their 2024 peaks.

The stages flicker: Extended → Clear → Extended within days. A badge
that changes this often would be noise on a card.

**False positives.** 2,471 Distribution-or-worse stock-days were
followed by a double within 252 sessions. The strongest: UAMY (Dec 2024,
Distribution, then +1,157%), IREN (Oct 2024, Trend broken, +849%) and
ORKA (Apr 2025, Trend broken, +838%).

## Recommendation

The pre-registered consequence of a pass is to build C1–C3 and re-test.
Before that, I'd recommend one cheap, pre-registered follow-up. It
decides whether the stages add anything over plain tightness:

1. **Flat-trail controls.** A flat 20% and a flat 15% trail on the same
   entries. If either matches the stage trail, the stage isn't the
   ingredient.
2. **A leaner score.** Drop the six signals with lift ≤ 1.06× from their
   groups, as a separate, labelled variant. It should not replace the
   pre-registered score.

Whatever the follow-up says, the stage chips can ship as information
under the facts-only rule, because each stage's lift is over 1.5×:
"Extended", "Trend broken", the signal chips. The score must never be
shown as a probability.
