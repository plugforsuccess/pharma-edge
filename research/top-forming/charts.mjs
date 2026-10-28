// Price with the stage shaded behind it, TopScore under it. Plain SVG, dark.
const COLOR = { clear: '#2fd17c22', extended: '#f0b44c33', distribution: '#fb923c40', broken: '#e5484d4d' }
export function stageChartSvg({ bars, score, stage }, title, { w = 760, h = 360 } = {}) {
  const n = bars.length, px = 48, top = 34, ph = 210, sh = 70, sy = top + ph + 16
  const X = (i) => px + (i / Math.max(1, n - 1)) * (w - px - 12)
  const lc = bars.map((b) => Math.log(b.c)), lo = Math.min(...lc), hi = Math.max(...lc)
  const Y = (v) => top + ph - ((v - lo) / Math.max(1e-9, hi - lo)) * ph
  let shade = ''
  for (let i = 0; i < n; i++) if (stage[i] && stage[i] !== 'clear') shade += `<rect x="${X(i).toFixed(1)}" y="${top}" width="${Math.max(1, (w - px) / n).toFixed(2)}" height="${ph}" fill="${COLOR[stage[i]]}"/>`
  const path = bars.map((b, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(lc[i]).toFixed(1)}`).join('')
  const spath = score.map((s, i) => (s == null ? '' : `${i && score[i - 1] != null ? 'L' : 'M'}${X(i).toFixed(1)},${(sy + sh - (s / 100) * sh).toFixed(1)}`)).join('')
  const yr = []; let last = ''; bars.forEach((b, i) => { const y = b.t.slice(0, 4); if (y !== last) { last = y; yr.push(`<text x="${X(i)}" y="${h - 4}" fill="#9a9aa1" font-size="10">${y}</text>`) } })
  const priceLbl = (v) => `<text x="${px - 6}" y="${Y(Math.log(v)) + 4}" fill="#9a9aa1" font-size="10" text-anchor="end">$${v >= 10 ? v.toFixed(0) : v.toFixed(2)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, Arial, sans-serif"><rect width="${w}" height="${h}" fill="#0c0c0d"/><text x="12" y="20" fill="#f2f2f3" font-size="13">${title}</text>${shade}<path d="${path}" fill="none" stroke="#f2f2f3" stroke-width="1.2"/>${priceLbl(Math.exp(hi))}${priceLbl(Math.exp(lo))}<line x1="${px}" x2="${w - 12}" y1="${sy + sh - 0.35 * sh}" y2="${sy + sh - 0.35 * sh}" stroke="#27272a" stroke-dasharray="3 3"/><line x1="${px}" x2="${w - 12}" y1="${sy + sh - 0.6 * sh}" y2="${sy + sh - 0.6 * sh}" stroke="#27272a" stroke-dasharray="3 3"/><path d="${spath}" fill="none" stroke="#f0b44c" stroke-width="1"/><text x="${px - 6}" y="${sy + 8}" fill="#9a9aa1" font-size="10" text-anchor="end">100</text><text x="${px - 6}" y="${sy + sh}" fill="#9a9aa1" font-size="10" text-anchor="end">0</text>${yr.join('')}<text x="${w - 12}" y="20" fill="#9a9aa1" font-size="10" text-anchor="end">shade: amber Extended · orange Distribution · red Trend broken</text></svg>`
}
