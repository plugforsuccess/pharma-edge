// Milestone ledger on a holding (owner spec v2, 2026-10-26): each dated
// promise management made, where it stands, how many times the date moved.
// Header: the next promise and days to it, what's due this quarter, what's
// past due with no evidence, cash and burn as plain numbers. Rows: first
// promised → current date, slips, status, evidence needed. Facts only; the
// record never feeds a score. Rows live in holding_milestones (own rows).
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, X, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { milestoneState, ledgerSummary, ledgerLines, dueOf } from '../utils/milestones'

const todayYmd = () => new Date().toISOString().slice(0, 10)
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const inputCls = 'min-h-[44px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none focus:border-amber-400/60 focus:ring-1 focus:ring-amber-400/30 transition-colors'
const chip = 'min-h-[36px] px-2.5 rounded-lg border text-xs transition'
const STATE_TEXT = {
  met: 'Met', missed: 'Missed', overdue: 'Past due · unconfirmed', pending: 'Pending', unmentioned: 'Not mentioned',
}

export default function MilestoneLedger({ ticker, positionId, cashLine = null }) {
  const { user } = useAuth()
  const [rows, setRows] = useState(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', due: '', source: '', evidence: '' })
  const [moving, setMoving] = useState(null) // row id awaiting a new date
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
  // A restated date: the row keeps its first promise, gets the new date and one more slip.
  const move = (row) => patch(row, { current_due: newDue, slips: (row.slips ?? 0) + 1, status: 'pending', resolved_on: null })
  async function remove(row) {
    const { error } = await supabase.from('holding_milestones').delete().eq('id', row.id).eq('user_id', user.id)
    if (error) { setErr(error.message); return }
    setRows((r) => r.filter((x) => x.id !== row.id))
  }

  const sum = ledgerSummary(rows ?? [], today)
  const lines = ledgerLines(sum)
  return (
    <div className="mb-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted">Milestones</div>
          {lines.length ? lines.map((l, i) => <div key={i} className={clsx('text-sm', i === 0 ? 'text-fg' : 'text-subtle')}>{l}</div>)
            : <div className="text-sm text-subtle">What management promised, and when. Add each dated promise from calls and press releases.</div>}
          {cashLine && <div className="text-sm text-subtle">{cashLine}</div>}
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} aria-label="Add milestone"
            className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-fg hover:border-amber-400/40 transition">
            <Plus size={14} />
          </button>
        )}
      </div>
      {adding && (
        <div className="mt-2 space-y-2">
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
      )}
      {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
      {rows?.length > 0 && (
        <ul className="mt-2 divide-y divide-border border border-border rounded-xl overflow-hidden">
          {rows.map((row) => {
            const st = milestoneState(row, today)
            const open = st.kind !== 'met' && st.kind !== 'missed'
            const slips = row.slips ?? 0
            return (
              <li key={row.id} className="px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fg">{row.title}</div>
                    <div className="text-xs text-muted">
                      {slips > 0 ? <>First {fmtDay(row.due_date)} · now {fmtDay(dueOf(row))} · moved {slips}×</> : <>Promised {fmtDay(row.due_date)}</>}
                      {row.source ? ` · ${row.source}` : ''}
                      {st.kind === 'met' ? (st.late > 0 ? ` · met ${st.late} days late` : ' · on time') : st.kind === 'pending' && st.daysLeft != null ? ` · in ${st.daysLeft} days` : ''}
                    </div>
                    {row.evidence && open && <div className="text-xs text-muted">Confirms it: {row.evidence}</div>}
                  </div>
                  <div className="text-xs text-subtle shrink-0 pt-0.5">{STATE_TEXT[st.kind]}</div>
                  <button type="button" onClick={() => remove(row)} aria-label="Remove milestone" className="shrink-0 -mr-1 min-h-[32px] min-w-[32px] flex items-center justify-center text-muted hover:text-fg"><X size={12} /></button>
                </div>
                {open && (
                  <div className="mt-2 flex flex-wrap gap-2 items-center">
                    <button type="button" onClick={() => mark(row, 'met')} className={clsx(chip, 'border-border text-fg flex items-center gap-1')}><Check size={12} /> Met</button>
                    <button type="button" onClick={() => mark(row, 'missed')} className={clsx(chip, 'border-border text-fg')}>Missed</button>
                    {st.kind !== 'unmentioned' && <button type="button" onClick={() => mark(row, 'unmentioned')} className={clsx(chip, 'border-border text-fg')}>Not mentioned</button>}
                    {moving === row.id ? (
                      <>
                        <input type="date" value={newDue} min={dueOf(row)} onChange={(e) => setNewDue(e.target.value)} className={clsx(inputCls, 'min-h-[36px] py-1 w-[150px] appearance-none')} aria-label="New date" />
                        <button type="button" disabled={!newDue} onClick={() => move(row)} className={clsx(chip, 'border-amber-400/50 text-amber-200 disabled:opacity-40')}>Save</button>
                        <button type="button" onClick={() => { setMoving(null); setNewDue('') }} className={clsx(chip, 'border-border text-subtle')}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setMoving(row.id)} className={clsx(chip, 'border-border text-fg')}>Date moved</button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
