import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { TICKER_UNIVERSE } from '../lib/tickerUniverse'

// Tracking (the `watchlist` table) as one shared list (owner, 2026-10-19:
// "How can I favorite leaps?" → a star on Leaders rows and the entry chart).
// Every component using the hook sees the same list, so a star tapped on the
// entry chart shows on Leaders' "Yours" without a reload. Optimistic, rolled
// back when the write fails. The table has no unique (user, ticker) key, so
// removing a ticker deletes every row for it.

let list = null
let loading = false
let userId = null
const subs = new Set()
const emit = () => subs.forEach((f) => f(list))

async function load() {
  loading = true
  const { data: auth } = await supabase.auth.getUser()
  userId = auth?.user?.id ?? null
  if (!userId) { list = []; loading = false; emit(); return }
  const { data } = await supabase.from('watchlist').select('ticker').eq('user_id', userId)
  list = [...new Set((data ?? []).map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean))]
  loading = false
  emit()
}

supabase.auth.onAuthStateChange((_e, session) => {
  if ((session?.user?.id ?? null) !== userId) { list = null; if (subs.size) load() }
})

async function toggle(sym) {
  const symbol = String(sym || '').toUpperCase()
  if (!symbol || !userId || !list) return
  if (list.includes(symbol)) {
    list = list.filter((t) => t !== symbol); emit()
    const { error } = await supabase.from('watchlist').delete().eq('user_id', userId).eq('ticker', symbol)
    if (error) { list = [...list, symbol]; emit() }
  } else {
    list = [...list, symbol]; emit()
    const label = TICKER_UNIVERSE.find((t) => t.symbol === symbol)?.label || symbol
    const { error } = await supabase.from('watchlist').insert({ user_id: userId, ticker: symbol, company_name: label })
    if (error) { list = list.filter((t) => t !== symbol); emit() }
  }
}

// → { tracking: string[] | null (loading), isTracked(sym), toggle(sym) }
export function useTracking() {
  const [mine, setMine] = useState(list)
  useEffect(() => {
    subs.add(setMine)
    if (list == null && !loading) load()
    else setMine(list)
    return () => { subs.delete(setMine) }
  }, [])
  return { tracking: mine, isTracked: (s) => !!mine?.includes(String(s).toUpperCase()), toggle }
}
