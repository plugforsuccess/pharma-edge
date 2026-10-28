// Plain SVG charts for the report (no dependencies). Dark background to match the app.
const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c])
const frame = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, Arial, sans-serif"><rect width="${w}" height="${h}" fill="#0c0c0d"/><text x="16" y="24" fill="#f2f2f3" font-size="14">${esc(title)}</text>${body}</svg>`

export function histogramSvg(values, title, { w = 640, h = 300, lo = -1, hi = 3, bins = 40 } = {}) {
  const v = values.filter(Number.isFinite), counts = new Array(bins).fill(0)
  for (const x of v) counts[Math.min(bins - 1, Math.max(0, Math.floor(((Math.min(hi, Math.max(lo, x)) - lo) / (hi - lo)) * bins)))]++
  const max = Math.max(1, ...counts), px = 40, py = 40, cw = (w - px - 16) / bins, ch = h - py - 36
  const bars = counts.map((c, i) => { const x0 = lo + (i / bins) * (hi - lo); const bh = (c / max) * ch; return `<rect x="${px + i * cw + 1}" y="${py + ch - bh}" width="${cw - 2}" height="${bh}" fill="${x0 < 0 ? '#e5484d' : '#2fd17c'}"/>` }).join('')
  const zx = px + ((0 - lo) / (hi - lo)) * (w - px - 16)
  const ticks = [lo, lo / 2, 0, hi / 2, hi].map((t) => `<text x="${px + ((t - lo) / (hi - lo)) * (w - px - 16)}" y="${h - 12}" fill="#9a9aa1" font-size="11" text-anchor="middle">${Math.round(t * 1000) / 10}%</text>`).join('')
  return frame(w, h, `${title} · n ${v.length}`, `${bars}<line x1="${zx}" x2="${zx}" y1="${py}" y2="${py + ch}" stroke="#9a9aa1" stroke-dasharray="3 3"/>${ticks}`)
}

export function equitySvg(trades, title, { w = 640, h = 300 } = {}) {
  const t = [...trades].sort((a, b) => a.date.localeCompare(b.date))
  let eq = 0
  const pts = [[t[0]?.date ?? '', 0], ...t.map((x) => [x.date, (eq += x.pnl)])]
  const ys = pts.map((p) => p[1]), lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), px = 56, py = 40, cw = w - px - 16, ch = h - py - 36
  const X = (i) => px + (i / Math.max(1, pts.length - 1)) * cw, Y = (y) => py + ch - ((y - lo) / Math.max(1, hi - lo)) * ch
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')
  const lab = (y) => `<text x="${px - 6}" y="${Y(y) + 4}" fill="#9a9aa1" font-size="11" text-anchor="end">$${Math.round(y).toLocaleString('en-US')}</text>`
  return frame(w, h, `${title} · ${t.length} trades`, `<line x1="${px}" x2="${px + cw}" y1="${Y(0)}" y2="${Y(0)}" stroke="#27272a"/><path d="${path}" fill="none" stroke="${eq >= 0 ? '#2fd17c' : '#e5484d'}" stroke-width="2"/>${lab(hi)}${lab(0)}${lo < 0 ? lab(lo) : ''}<text x="${px}" y="${h - 12}" fill="#9a9aa1" font-size="11">${esc(pts[0][0])}</text><text x="${px + cw}" y="${h - 12}" fill="#9a9aa1" font-size="11" text-anchor="end">${esc(pts.at(-1)[0])}</text>`)
}
