// What could hurt a leader, from data the app already has (owner,
// 2026-10-19: "it should be more about the leaders, their momentum, the
// market and risks"). Facts only, never advice. Each flag:
// { key, tone: 'red' | 'amber' | 'neutral', title, body }.

// Groups whose prices move with a commodity — a supply shock can reverse.
export const COMMODITY_GROUPS = Object.freeze({
  Oil: 'crude oil', Refiners: 'fuel margins', 'Oil services': 'crude oil', Pipelines: 'energy prices',
  'Gold miners': 'gold', 'Metals & mining': 'metals prices', Uranium: 'uranium', Solar: 'policy and power prices',
})
export const RISK = Object.freeze({ stretched: 0.35, veryStretched: 0.6, earningsDays: 14, pullback: 0.10 })

const DAY = 86400000
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// traits: leader_traits ({ mom12, vs200, slope200, off20, theme }),
// earnings: { date, time } | null, asOf: 'YYYY-MM-DD', groupSize: leaders sharing the theme.
export function leaderFlags({ traits, earnings = null, asOf, groupSize = 1 }) {
  const out = []
  if (!traits) return out
  if (earnings?.date && asOf) {
    const d = daysBetween(asOf, earnings.date)
    if (d >= 0 && d <= RISK.earningsDays) {
      const when = earnings.time === 'BMO' ? 'before the open' : earnings.time === 'AMC' ? 'after the close' : ''
      out.push({ key: 'earnings', tone: d <= 3 ? 'red' : 'amber', title: `Earnings ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : fmtDay(earnings.date)}`,
        body: `Reports ${when || 'soon'} — the price can gap either way on the results.` })
    }
  }
  if (traits.vs200 != null && traits.vs200 >= RISK.stretched) {
    const very = traits.vs200 >= RISK.veryStretched
    out.push({ key: 'stretched', tone: very ? 'red' : 'amber', title: `${very ? 'Very stretched' : 'Stretched'}: ${Math.round(traits.vs200 * 100)}% above its 200-day`,
      body: 'Far above its long-term average — pullbacks from here tend to be larger.' })
  }
  const theme = traits.theme?.name
  if (theme && COMMODITY_GROUPS[theme]) {
    out.push({ key: 'commodity', tone: 'amber', title: `Moves with ${COMMODITY_GROUPS[theme]}`,
      body: 'Driven by a commodity price — news that changes supply can reverse it quickly.' })
  }
  if (traits.off20 != null && traits.off20 >= RISK.pullback) {
    out.push({ key: 'pullback', tone: 'neutral', title: `${Math.round(traits.off20 * 100)}% off its recent high`,
      body: 'Still a leader, but pulling back from its 20-day high.' })
  }
  if (theme && groupSize >= 3) {
    out.push({ key: 'crowded', tone: 'neutral', title: `${groupSize} leaders in ${theme}`,
      body: 'One group dominates — a single headline can move all of them.' })
  }
  return out
}
