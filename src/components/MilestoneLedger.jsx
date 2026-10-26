// Milestone ledger on a holding (owner spec, 2026-10-26): the promises the
// company made, dated, and what became of each — met, missed or delayed.
// The holder enters them; the ledger states the record (src/utils/milestones.js).
// Facts only, no verdict. Rows live in holding_milestones (own rows, RLS).
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus, X, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { milestoneState, ledgerSummary, ledgerLine } from '../utils/milestones'

const todayYmd = () => new Date().toISOString().slice(0, 10)
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const inputCls = 'min-h-[44px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none focus:border-amber-400/60 focus:ring-1 focus:ring-amber-400/30 transition-colors'
const chip = 'min-h-[36px] px-2.5 rounded-lg border text-xs transition'
const STATE_TEXT = {
  met: { label: 'Met', cls: 'text-green-300' },
  missed: { label: 'Missed', cls: 'text-red-300' },
  delayed: { label: 'Delayed', cls: 'text-amber-300' },
  overdue: { label: 'Past due · no word', cls: 'text-amber-300' },
  pending: { label: 'Pending', cls: 'text-subtle' },
}

export default function MilestoneLedger({ ticker, positionId }) {
  const { user } = useAuth()
  const [rows, setRows] = useState(null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [delaying, setDelaying] = useState(null) // row id awaiting a new date
  const [newDue, setNewDue] = useState('')
  const [err, setErr] = useState(null)
  const today = todayYmd()

  useEffect(() => {
    let cancelled = false
    if (!user || !ticker) return undefined
    supabase.from('holding_milestones').select('*').eq('user_id', user.id).eq('ticker', ticker).order('due_date')
      .then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
    return () => { cancelled = true }
  }, [user, ticker])

  async function add() {
    if (!title.trim() || !due) return
    setErr(null)
    const { data, error } = await supabase.from('holding_milestones').insert({ user_id: user.id, ticker, position_id: positionId ?? null, title: title.trim(), due_date: due }).select().single()
    if (error) { setErr(error.message); return }
    setRows((r) => [...(r ?? []), data].sort((a, b) => a.due_date.localeCompare(b.due_date)))
    setTitle(''); setDue(''); setAdding(false)
  }
  async function mark(row, status, extra = {}) {
    setErr(null)
    const patch = { status, updated_at: new Date().toISOString(), resolved_on: status === 'met' || status === 'missed' ? today : null, new_due_date: status === 'delayed' ? extra.new_due_date : null }
    const { error } = await supabase.from('holding_milestones').update(patch).eq('id', row.id).eq('user_id', user.id)
    if (error) { setErr(error.message); return }
    setRows((r) => r.map((x) => (x.id === row.id ? { ...x, ...patch } : x)))
    setDelaying(null); setNewDue('')
  }
  async function remove(row) {
    const { error } = await supabase.from('holding_milestones').delete().eq('id', row.id).eq('user_id', user.id)
    if (error) { setErr(error.message); return }
    setRows((r) => r.filter((x) => x.id !== row.id))
  }

  const sum = ledgerSummary(rows ?? [], today)
  const line = ledgerLine(sum)
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted">Milestones</div>
          <div className="text-sm text-fg">{line ?? 'What the company promised, and when. Add the dates it gave.'}</div>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} aria-label="Add milestone"
            className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-fg hover:border-amber-400/40 transition">
            <Plus size={14} />
          </button>
        )}
      </div>
      {adding && (
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 items-start">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What was promised (e.g. Phase 3 readout)" className={clsx(inputCls, 'w-full')} maxLength={120} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={clsx(inputCls, 'w-[150px] appearance-none')} aria-label="Promised by" />
          <div className="col-span-2 flex gap-2 justify-end">
            <button type="button" onClick={() => { setAdding(false); setTitle(''); setDue('') }} className={clsx(chip, 'border-border text-subtle hover:text-fg')}>Cancel</button>
            <button type="button" onClick={add} disabled={!title.trim() || !due} className={clsx(chip, 'border-amber-400/50 text-amber-200 disabled:opacity-40')}>Add</button>
          </div>
        </div>
      )}
      {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
      {rows?.length > 0 && (
        <ul className="mt-2 divide-y divide-border border border-border rounded-xl overflow-hidden">
          {rows.map((row) => {
            const st = milestoneState(row, today)
            const t = STATE_TEXT[st.kind]
            const open = st.kind === 'pending' || st.kind === 'overdue' || st.kind === 'delayed'
            return (
              <li key={row.id} className="px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fg truncate">{row.title}</div>
                    <div className="text-xs text-muted">
                      {st.kind === 'delayed' ? <>Was {fmtDay(row.due_date)} · now {fmtDay(st.due)}{st.slip != null ? ` (+${st.slip} days)` : ''}</>
                        : st.kind === 'met' ? <>Promised {fmtDay(row.due_date)}{st.late > 0 ? ` · met ${st.late} days late` : ' · on time'}</>
                        : <>Promised {fmtDay(row.due_date)}{st.kind === 'pending' && st.daysLeft != null ? ` · in ${st.daysLeft} days` : ''}</>}
                    </div>
                  </div>
                  <div className={clsx('text-xs shrink-0 pt-0.5', t.cls)}>{t.label}</div>
                  <button type="button" onClick={() => remove(row)} aria-label="Remove milestone" className="shrink-0 -mr-1 min-h-[32px] min-w-[32px] flex items-center justify-center text-muted hover:text-fg"><X size={12} /></button>
                </div>
                {open && (
                  <div className="mt-2 flex flex-wrap gap-2 items-center">
                    <button type="button" onClick={() => mark(row, 'met')} className={clsx(chip, 'border-green-500/40 text-green-200 flex items-center gap-1')}><Check size={12} /> Met</button>
                    <button type="button" onClick={() => mark(row, 'missed')} className={clsx(chip, 'border-red-500/40 text-red-200')}>Missed</button>
                    {delaying === row.id ? (
                      <>
                        <input type="date" value={newDue} min={row.due_date} onChange={(e) => setNewDue(e.target.value)} className={clsx(inputCls, 'min-h-[36px] py-1 w-[150px] appearance-none')} aria-label="New date" />
                        <button type="button" disabled={!newDue} onClick={() => mark(row, 'delayed', { new_due_date: newDue })} className={clsx(chip, 'border-amber-400/50 text-amber-200 disabled:opacity-40')}>Save</button>
                        <button type="button" onClick={() => { setDelaying(null); setNewDue('') }} className={clsx(chip, 'border-border text-subtle')}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setDelaying(row.id)} className={clsx(chip, 'border-amber-500/40 text-amber-200')}>{st.kind === 'delayed' ? 'Delayed again' : 'Delayed'}</button>
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
