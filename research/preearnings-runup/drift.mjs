// Diagnostic only (PREREG §9): pre-event stock drift on confirmed in-sample events vs
// control windows. Never graded, never the answer; held-out events are not read.
import { readFileSync, writeFileSync } from 'node:fs'
import { RULES, controlLs, bootstrapMean, weekKey } from './lib.mjs'
import { histogramSvg } from './charts.mjs'

const { events } = JSON.parse(readFileSync('events.json', 'utf8'))
const { sessions, closes, opens } = JSON.parse(readFileSync('bars.json', 'utf8'))
const conf = events.filter((e) => e.status === 'confirmed' && e.L && e.L < RULES.oosFrom)
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`)
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)
const report = { rules: RULES.version, period: `in-sample, L < ${RULES.oosFrom}`, events: conf.length, windows: {} }
const realLsBy = new Map()
for (const e of events) if (e.L) (realLsBy.get(e.tk) ?? realLsBy.set(e.tk, []).get(e.tk)).push(sessions.indexOf(e.L))
const win = (tk, L, k) => { const c = closes[tk]; if (!c) return null; if (k === 'same-day') { const o = opens[tk]?.[L]; return o && c[L] ? c[L] / o - 1 : null } return c[L] && c[L - k] ? c[L] / c[L - k] - 1 : null }
console.log(`Pre-event stock drift · ${report.period} · ${conf.length} confirmed events`)
console.log(`  ${'window'.padEnd(18)} ${'n'.padStart(5)} ${'mean'.padStart(8)} ${'median'.padStart(8)} ${'up'.padStart(6)} ${'|move|'.padStart(8)} ${'ctrl mean'.padStart(10)} ${'ctrl |move|'.padStart(12)} ${'event−ctrl 95% CI'.padStart(22)} ${'|move| ratio'.padStart(12)}`)
for (const k of [5, 3, 2, 1, 'same-day']) {
  const ev = [], ct = []
  for (const e of conf) {
    if (k === 'same-day' && e.timing !== 'AMC') continue
    const L = sessions.indexOf(e.L); const r = win(e.tk, L, k); if (r == null) continue
    ev.push({ date: e.L, r })
    for (const pl of controlLs(sessions, realLsBy.get(e.tk) ?? [], L, { salt: e.tk.charCodeAt(0) })) { if (sessions[pl] >= RULES.oosFrom) continue; const x = win(e.tk, pl, k); if (x != null) ct.push(x) }
  }
  const cm = mean(ct), ca = mean(ct.map(Math.abs))
  const diff = bootstrapMean(ev.map((x) => ({ cluster: weekKey(x.date), x: x.r - cm })), { reps: 5000 })
  const absDiff = bootstrapMean(ev.map((x) => ({ cluster: weekKey(x.date), x: Math.abs(x.r) - ca })), { reps: 5000 })
  const em = mean(ev.map((x) => x.r)), ea = mean(ev.map((x) => Math.abs(x.r)))
  const label = k === 'same-day' ? 'open→close of L (AMC)' : `L−${k} close → L close`
  report.windows[k] = { n: ev.length, mean: em, median: med(ev.map((x) => x.r)), up: ev.filter((x) => x.r > 0).length / ev.length, absMean: ea, controlN: ct.length, controlMean: cm, controlAbs: ca, diff, absDiff }
  console.log(`  ${label.padEnd(18)} ${String(ev.length).padStart(5)} ${pct(em).padStart(8)} ${pct(med(ev.map((x) => x.r))).padStart(8)} ${pct(ev.filter((x) => x.r > 0).length / ev.length).padStart(6)} ${pct(ea).padStart(8)} ${pct(cm).padStart(10)} ${pct(ca).padStart(12)} ${`[${pct(diff.lo)}, ${pct(diff.hi)}]`.padStart(22)} ${(ea / ca).toFixed(2).padStart(12)}`)
  if (k === 2) writeFileSync('drift-2day-histogram.svg', histogramSvg(ev.map((x) => x.r), 'Stock move, L−2 close → L close (in-sample)', { lo: -0.2, hi: 0.2 }))
}
writeFileSync('drift.json', JSON.stringify(report, null, 1))
console.log('wrote drift.json')
