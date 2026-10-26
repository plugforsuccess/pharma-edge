// Milestone ledger on a holding (owner spec v2, 2026-10-26; owner, same
// day: "one long screen scroll, too many text" → the card shows a compact
// strip, the full ledger lives in a modal). Strip: three tiles — the next
// promise and days to it, due this quarter, past due with no evidence —
// and one line of cash and burn. Tap anywhere → the ledger: every dated
// promise (first date → current date, slips, status, evidence) with Met ·
// Missed · Not mentioned · Date moved, and the add form. Facts only; the
// record never feeds a score. Rows live in holding_milestones (own rows).
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, X, Check, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import Modal from './Modal'
import { milestoneState, ledgerSummary, ledgerLines, dueOf } from '../utils/milestones'

const todayYmd = () => new Date().toISOString().slice(0, 10)
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fmtDayYear = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const inputCls = 'min-h-[44px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none focus:border-amber-400/60 focus:ring-1 focus:ring-amber-400/30 transition-colors'
const chip = 'min-h-[34px] px-2.5 rounded-lg border text-xs font-medium transition'
// Status pill + the hero on the left of each row: the countdown while a
// promise is open, what became of it once it isn't.
const PILL = {
  met: 'bg-green-500/15 text-green-300', missed: 'bg-red-500/15 text-red-300', overdue: 'bg-red-500/15 text-red-300',
  unmentioned: 'bg-amber-500/15 text-amber-300', pending: 'bg-bg text-subtle border border-border',
}
const STATE_TEXT = { met: 'Met', missed: 'Missed', overdue: 'Past due', pending: 'Pending', unmentioned: 'Not mentioned' }
function Hero({ st }) {
  if (st.kind === 'met') return <div className="text-green-300"><Check size={22} strokeWidth={2.5} /></div>
  if (st.kind === 'missed') return <div className="text-red-300"><X size={22} strokeWidth={2.5} /></div>
  if (st.kind === 'overdue') return <div className="text-xl font-semibold font-mono-tab text-red-300 leading-none">{Math.abs(st.daysLeft)}d<div className="text-[10px] font-sans font-normal text-red-300/80 mt-0.5">late</div></div>
  // Open promises count down in the brand gold; past due is red.
  return <div className="text-xl font-semibold font-mono-tab leading-none text-amber-300">{st.daysLeft == null ? '—' : st.daysLeft === 0 ? 'now' : `${st.daysLeft}d`}</div>
}

function Tile({ label, value, sub, tone = 'fg' }) {
  return (
    <div className="min-w-0 rounded-xl bg-bg/40 border border-border px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold truncate">{label}</div>
      <div className={clsx('mt-0.5 text-xl font-semibold font-mono-tab truncate leading-tight', tone === 'amber' ? 'text-amber-300' : tone === 'red' ? 'text-red-300' : 'text-fg')}>{value}</div>
      {sub && <div className="text-xs text-subtle truncate">{sub}</div>}
    </div>
  )
}

export default function MilestoneLedger({ ticker, positionId, cashLine = null }) {
  const { user } = useAuth()
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', due: '', source: '', evidence: '' })
  const [moving, setMoving] = useState(null)
  const [newDue, setNewDue] = useState('')
  const [err, setErr] = useState(null)
  const today = todayYmd()
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    let cancelled = false
    if (!user || !ticker) return undefined
    supabase.from('holding_milestones').select('*').eq('user_id', user.id).eq('ticker', ticker).order('due_date')
      .then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
    return () => { cancelled = true }
  }, [user, ticker])

  const sortRows = (r) => [...r].sort((a, b) => dueOf(a).localeCompare(dueOf(b)))
  async function add() {
    if (!form.title.trim() || !form.due) return
    setErr(null)
    const { data, error } = await supabase.from('holding_milestones').insert({ user_id: user.id, ticker, position_id: positionId ?? null, title: form.title.trim(), due_date: form.due, source: form.source.trim() || null, evidence: form.evidence.trim() || null }).select().single()
    if (error) { setErr(error.message); return }
    setRows((r) => sortRows([...(r ?? []), data]))
    setForm({ title: '', due: '', source: '', evidence: '' }); setAdding(false)
  }
  async function patch(row, p) {
    setErr(null)
    const body = { ...p, updated_at: new Date().toISOString() }
    const { error } = await supabase.from('holding_milestones').update(body).eq('id', row.id).eq('user_id', user.id)
    if (error) { setErr(error.message); return }
    setRows((r) => sortRows(r.map((x) => (x.id === row.id ? { ...x, ...body } : x))))
    setMoving(null); setNewDue('')
  }
  const mark = (row, status) => patch(row, { status, resolved_on: status === 'met' || status === 'missed' ? today : null })
  const move = (row) => patch(row, { current_due: newDue, slips: (row.slips ?? 0) + 1, status: 'pending', resolved_on: null })
  async function remove(row) {
    const { error } = await supabase.from('holding_milestones').delete().eq('id', row.id).eq('user_id', user.id)
    if (error) { setErr(error.message); return }
    setRows((r) => r.filter((x) => x.id !== row.id))
  }

  const sum = ledgerSummary(rows ?? [], today)
  const n = rows?.length ?? 0
  return (
    <div className="mb-4">
      <button type="button" onClick={() => setOpen(true)} className="w-full text-left group">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Promises</div>
          <div className="flex items-center gap-0.5 text-xs text-subtle group-hover:text-fg transition">{n ? `All ${n}` : 'Add'} <ChevronRight size={14} /></div>
        </div>
        {n ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Tile label="Next" value={sum.next ? (sum.next.daysLeft === 0 ? 'Today' : `${sum.next.daysLeft}d`) : '—'} sub={sum.next ? sum.next.row.title : 'None dated'} tone={sum.next ? 'amber' : 'fg'} />
            <Tile label="This qtr" value={String(sum.dueThisQuarter.length)} sub="due" />
            <Tile label="Past due" value={String(sum.overdue.length + sum.unmentioned.length)} sub={sum.overdue.length + sum.unmentioned.length ? 'no word' : 'none'} tone={sum.overdue.length + sum.unmentioned.length ? 'red' : 'fg'} />
          </div>
        ) : (
          <div className="mt-2 text-sm text-subtle">What management promised, and when.</div>
        )}
        {(cashLine || (n && sum.resolved)) && (
          <div className="mt-1.5 text-xs text-subtle truncate">
            {[cashLine, n && sum.resolved ? `${sum.onTime} of ${sum.resolved} met on time` : null, n && sum.slipped ? `${sum.slipped} moved` : null].filter(Boolean).join(' · ')}
          </div>
        )}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} ariaLabel={`${ticker} promises`} size="lg">
        <div className="max-h-[82vh] overflow-y-auto -m-1 p-1 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{ticker} · Promises</div>
            {ledgerLines(sum).slice(-1).map((l, i) => <div key={i} className="text-sm text-fg">{l}</div>)}
            {cashLine && <div className="text-xs text-subtle">{cashLine}</div>}
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center text-subtle hover:text-fg"><X size={16} /></button>
        </div>
        <div>
          {rows?.length > 0 && (
            <ul className="divide-y divide-border border border-border rounded-xl overflow-hidden">
              {rows.map((row) => {
                const st = milestoneState(row, today)
                const isOpen = st.kind !== 'met' && st.kind !== 'missed'
                const slips = row.slips ?? 0
                return (
                  <li key={row.id} className={clsx('px-3 py-3 flex gap-3', st.kind === 'overdue' && 'bg-red-500/5', st.kind === 'unmentioned' && 'bg-amber-500/5')}>
                    <div className="w-11 shrink-0 pt-0.5"><Hero st={st} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0 text-sm font-semibold text-fg leading-snug">{row.title}</div>
                        <span className={clsx('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', PILL[st.kind])}>{STATE_TEXT[st.kind]}</span>
                        <button type="button" onClick={() => remove(row)} aria-label="Remove milestone" className="shrink-0 -mr-1 -mt-1 min-h-[28px] min-w-[28px] flex items-center justify-center text-muted hover:text-fg"><X size={12} /></button>
                      </div>
                      <div className={clsx('mt-0.5 text-sm font-semibold font-mono-tab', st.kind === 'overdue' ? 'text-red-300' : isOpen ? 'text-amber-300' : 'text-subtle')}>
                        {fmtDayYear(dueOf(row))}
                        {slips > 0 && <span className="ml-2 text-xs font-sans font-medium text-subtle">moved {slips}× · was {fmtDay(row.due_date)}</span>}
                        {st.kind === 'met' && st.late > 0 && <span className="ml-2 text-xs font-sans font-medium text-subtle">{st.late} days late</span>}
                      </div>
                      {row.source && <div className="text-xs text-muted truncate">{row.source}</div>}
                      {row.evidence && isOpen && <div className="text-xs text-muted truncate">Confirms: {row.evidence}</div>}
                      {isOpen && (
                        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                          <button type="button" onClick={() => mark(row, 'met')} className={clsx(chip, 'border-green-500/40 text-green-200 flex items-center gap-1')}><Check size={12} /> Met</button>
                          <button type="button" onClick={() => mark(row, 'missed')} className={clsx(chip, 'border-red-500/40 text-red-200')}>Missed</button>
                          {st.kind !== 'unmentioned' && <button type="button" onClick={() => mark(row, 'unmentioned')} className={clsx(chip, 'border-amber-500/40 text-amber-200')}>Not mentioned</button>}
                          {moving === row.id ? (
                            <>
                              <input type="date" value={newDue} min={dueOf(row)} onChange={(e) => setNewDue(e.target.value)} className={clsx(inputCls, 'min-h-[36px] py-1 w-[150px] appearance-none')} aria-label="New date" />
                              <button type="button" disabled={!newDue} onClick={() => move(row)} className={clsx(chip, 'border-amber-400/50 text-amber-200 disabled:opacity-40')}>Save</button>
                              <button type="button" onClick={() => { setMoving(null); setNewDue('') }} className={clsx(chip, 'border-border text-subtle')}>Cancel</button>
                            </>
                          ) : (
                            <button type="button" onClick={() => setMoving(row.id)} className={clsx(chip, 'border-border text-subtle hover:text-fg')}>Date moved</button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {adding ? (
            <div className="mt-3 space-y-2">
              <input value={form.title} onChange={setF('title')} placeholder="What was promised (e.g. UL certification)" className={clsx(inputCls, 'w-full')} maxLength={120} />
              <div className="grid grid-cols-[150px_1fr] gap-2">
                <input type="date" value={form.due} onChange={setF('due')} className={clsx(inputCls, 'appearance-none')} aria-label="Promised by" />
                <input value={form.source} onChange={setF('source')} placeholder="Where (e.g. Q4 2025 call)" className={inputCls} maxLength={80} />
              </div>
              <input value={form.evidence} onChange={setF('evidence')} placeholder="What would confirm it (e.g. 8-K naming the cert)" className={clsx(inputCls, 'w-full')} maxLength={160} />
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setAdding(false); setForm({ title: '', due: '', source: '', evidence: '' }) }} className={clsx(chip, 'border-border text-subtle hover:text-fg')}>Cancel</button>
                <button type="button" onClick={add} disabled={!form.title.trim() || !form.due} className={clsx(chip, 'border-amber-400/50 text-amber-200 disabled:opacity-40')}>Add</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="mt-3 min-h-[44px] w-full flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-subtle hover:text-fg hover:border-amber-400/40 transition">
              <Plus size={14} /> Add a promise
            </button>
          )}
          {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
        </div>
        <div className="text-[11px] text-muted">Dates management gave, as you logged them. Slips are facts, not a score.</div>
        </div>
      </Modal>
    </div>
  )
}
