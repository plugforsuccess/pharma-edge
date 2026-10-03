import { useEffect, useRef, useState } from 'react'
import { Download, Share2 } from 'lucide-react'
import clsx from 'clsx'
import Modal from './Modal'

// Peers → Share (owner, 2026-10-03: "can the user share this card with
// friends?"). Draws a square Cash Moves image on a canvas — the rank,
// who it's against, up to three more rows — and hands it to the phone's
// share sheet (or downloads it). The dollar figure is off by default:
// net worth is private; the user can switch it on.
const SIZE = 1080
const C = {
  bg: '#0c0c0d', card: '#161618', fg: '#f2f2f3', subtle: '#9a9aa1', muted: '#5f5f68', gold: '#f0b44c', green: '#2fd17c', hair: '#27272a',
}
const compact = (n) => {
  const a = Math.abs(n)
  const s = a >= 1e6 ? `$${+(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`
  return n < 0 ? `−${s}` : s
}

// Draw the card. `head` = the headline row, `rows` = the rest, `age` = the
// age-band text ("under 35"), `netWorth` only when showing dollars.
export async function drawShareCard(canvas, { head, rows, age, netWorth = null, source }) {
  const ctx = canvas.getContext('2d')
  canvas.width = SIZE
  canvas.height = SIZE
  try { await Promise.all(['800 170px', '600 44px', '500 36px'].map((f) => document.fonts.load(`${f} "Inter Tight"`))) } catch { /* system font */ }
  const font = (w, px) => `${w} ${px}px "Inter Tight", system-ui, sans-serif`
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, SIZE, SIZE)
  // Card
  const pad = 72
  const r = 48
  ctx.fillStyle = C.card
  ctx.beginPath()
  ctx.roundRect(pad, pad, SIZE - pad * 2, SIZE - pad * 2, r)
  ctx.fill()
  ctx.strokeStyle = 'rgba(240, 180, 76, 0.35)'
  ctx.lineWidth = 2
  ctx.stroke()
  const x = pad + 72
  let y = pad + 110
  // Wordmark
  ctx.fillStyle = C.gold
  ctx.font = font(700, 34)
  ctx.letterSpacing = '6px'
  ctx.fillText('CASH MOVES', x, y)
  ctx.letterSpacing = '0px'
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.font = font(500, 30)
  ctx.fillText('cashmoves.io', SIZE - x, y)
  ctx.textAlign = 'left'
  // Eyebrow
  y += 120
  ctx.fillStyle = C.subtle
  ctx.font = font(500, 36)
  ctx.fillText('Net worth vs. US households', x, y)
  // Rank
  y += 170
  ctx.fillStyle = C.green
  ctx.font = font(800, 170)
  ctx.letterSpacing = '-6px'
  ctx.fillText(head.rank, x, y)
  ctx.letterSpacing = '0px'
  y += 64
  ctx.fillStyle = C.fg
  ctx.font = font(500, 40)
  ctx.fillText(age ? `of households ${age}` : 'of all US households', x, y)
  if (netWorth != null) {
    y += 56
    ctx.fillStyle = C.subtle
    ctx.font = font(500, 34)
    ctx.fillText(`Net worth before tax ${compact(netWorth)}`, x, y)
  }
  // Rows
  y += 90
  ctx.strokeStyle = C.hair
  ctx.lineWidth = 2
  for (const row of rows.slice(0, 3)) {
    ctx.beginPath(); ctx.moveTo(x, y - 48); ctx.lineTo(SIZE - x, y - 48); ctx.stroke()
    ctx.fillStyle = C.fg
    ctx.font = font(500, 36)
    const label = row.withinAge && age ? `${row.name} · ${age}` : row.name
    ctx.fillText(label, x, y)
    ctx.textAlign = 'right'
    ctx.fillStyle = (row.pct ?? 0) >= 50 ? C.green : C.subtle
    ctx.font = font(700, 36)
    ctx.fillText(row.rank, SIZE - x, y)
    ctx.textAlign = 'left'
    y += 84
  }
  // Footer
  ctx.fillStyle = C.muted
  ctx.font = font(500, 26)
  ctx.fillText(source, x, SIZE - pad - 64)
}

export default function PeersShare({ open, onClose, head, rows, age, netWorth, source }) {
  const [withDollars, setWithDollars] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const canvasRef = useRef(null)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'

  useEffect(() => {
    if (!open || !canvasRef.current || !head) return
    drawShareCard(canvasRef.current, { head, rows, age, netWorth: withDollars ? netWorth : null, source })
  }, [open, head, rows, age, netWorth, withDollars, source])

  const toFile = () => new Promise((resolve) => canvasRef.current.toBlob((b) => resolve(b && new File([b], 'cash-moves-rank.png', { type: 'image/png' })), 'image/png'))
  const share = async () => {
    setBusy(true)
    setDone(null)
    try {
      const file = await toFile()
      if (!file) return
      if (canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Cash Moves', text: `${head.rank} of US households${age ? ` ${age}` : ''} by net worth` })
        setDone('Shared')
      } else {
        download(file)
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setDone("Couldn't share — saved instead")
    } finally { setBusy(false) }
  }
  const download = (file) => {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setDone('Saved to your photos or downloads')
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Share your rank" size="md">
      <div className="p-5">
        <h2 className="text-sm font-semibold">Share your rank</h2>
        <canvas ref={canvasRef} className="mt-3 w-full rounded-xl border border-hairline" aria-label="Share image preview" />
        <label className="mt-4 flex items-center gap-3 min-h-[44px] cursor-pointer">
          <span className="flex-1 text-sm text-fg">Include my net worth</span>
          <button type="button" role="switch" aria-checked={withDollars} onClick={() => setWithDollars(!withDollars)}
            className={clsx('relative h-7 w-12 rounded-full transition', withDollars ? 'bg-amber-400' : 'bg-bg-elev border border-border')}>
            <span className={clsx('absolute top-0.5 h-6 w-6 rounded-full bg-fg transition', withDollars ? 'left-[22px]' : 'left-0.5')} />
          </button>
        </label>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={share} disabled={busy}
            className="min-h-[44px] rounded-xl bg-amber-400 text-bg text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
            <Share2 size={15} aria-hidden /> Share
          </button>
          <button type="button" onClick={async () => { const f = await toFile(); if (f) download(f) }} disabled={busy}
            className="min-h-[44px] rounded-xl bg-bg-elev text-fg text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
            <Download size={15} aria-hidden /> Save image
          </button>
        </div>
        {done && <p className="mt-2 text-xs text-subtle">{done}</p>}
      </div>
    </Modal>
  )
}
