import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ExternalLink, Loader, Lock, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import UpgradeNotice from './UpgradeNotice'
import clsx from 'clsx'

const LIVE_CONFIRM_PHRASE = 'LIVE'

export default function PlaceOrderPanel({ signal, calculation, onOrderPlaced }) {
  const { user } = useAuth()
  const { isPro, limits } = useSubscription()
  const [accounts, setAccounts] = useState([])
  const [accountsError, setAccountsError] = useState('')
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [fetchingAccounts, setFetchingAccounts] = useState(false)
  const [step, setStep] = useState('idle') // idle | confirm | submitted
  const [loading, setLoading] = useState(false)
  const [orderResult, setOrderResult] = useState(null)
  const [liveConfirm, setLiveConfirm] = useState('')

  const existingOrderInFlight = useMemo(() => {
    return ['pending', 'submitted', 'filled', 'partial_fill'].includes(
      signal?.order_status ?? '',
    )
  }, [signal?.order_status])

  useEffect(() => {
    fetchAccounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchAccounts() {
    setFetchingAccounts(true)
    setAccountsError('')
    try {
      const { data, error } = await supabase.functions.invoke('get-account')
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'failed to fetch accounts')
      setAccounts(data.accounts || [])
      const paper = data.accounts?.find((a) => a.is_paper)
      if (paper) setSelectedAccount(paper)
      else if (data.accounts?.length) setSelectedAccount(data.accounts[0])
    } catch (e) {
      setAccountsError(e.message || 'failed to load accounts')
    }
    setFetchingAccounts(false)
  }

  const liveConfirmed =
    selectedAccount?.is_paper || liveConfirm.trim().toUpperCase() === LIVE_CONFIRM_PHRASE

  async function submitOrder() {
    if (!selectedAccount || !calculation || !user) return
    setLoading(true)
    setOrderResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('place-order', {
        body: {
          signal_id: signal.id,
          account_number: selectedAccount.account_number,
          ticker: signal.ticker,
          structure: calculation.structure,
          buy_strike: Number(calculation.buyStrike ?? 0) || undefined,
          sell_strike: Number(calculation.sellStrike ?? 0) || undefined,
          expiry_date: calculation.expiry,
          contracts: calculation.contracts,
          limit_price: Number(calculation.premium ?? 0) || undefined,
          action_type: 'open',
        },
      })
      if (error) {
        // FunctionsHttpError exposes the original Response on .context.
        // Read the body so the user sees the actual broker-side reason
        // instead of supabase-js's generic 'non-2xx status code' string.
        let body = null
        try {
          body = await error.context?.json?.()
        } catch {
          /* ignore */
        }
        if (!body) {
          try {
            const text = await error.context?.text?.()
            if (text) body = { error: text }
          } catch {
            /* ignore */
          }
        }
        const detail =
          body?.detail && typeof body.detail === 'object'
            ? JSON.stringify(body.detail).slice(0, 500)
            : body?.detail
        setOrderResult({
          success: false,
          error: body?.error || error.message || 'order failed',
          detail,
        })
        setStep('submitted')
      } else {
        setOrderResult(data)
        setStep('submitted')
        if (data?.success) onOrderPlaced?.(data)
      }
    } catch (e) {
      setOrderResult({ success: false, error: e.message || 'order failed' })
      setStep('submitted')
    }
    setLoading(false)
  }

  if (!calculation) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <p className="text-muted text-xs text-center">
          Run the strike calculator above before placing an order.
        </p>
      </div>
    )
  }

  if (!isPro && !limits.brokerExecutionEnabled) {
    return (
      <div className="bg-card border border-amber-400/20 rounded-xl p-4 mb-4 space-y-3">
        <div className="flex items-center gap-2">
          <Lock size={14} className="text-amber-400" />
          <h3 className="text-white text-sm font-semibold">Place Order</h3>
        </div>
        <p className="text-subtle text-xs leading-relaxed">
          Broker execution via Tastytrade is a Pro feature. Free tier
          users still see the strike calculator and can place orders
          manually with their broker of choice.
        </p>
        <UpgradeNotice
          message="$39/mo unlocks one-tap broker execution + the rest of Pro."
          cta="Go Pro"
        />
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="text-white text-sm font-semibold">Place Order</h3>
        {selectedAccount && (
          <span
            className={clsx(
              'text-[10px] font-bold px-2 py-0.5 rounded-full border',
              selectedAccount.is_paper
                ? 'text-yellow-400 bg-yellow-950 border-yellow-800'
                : 'text-red-400 bg-red-950 border-red-800',
            )}
          >
            {selectedAccount.is_paper ? 'PAPER' : '⚠ LIVE'}
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
        {existingOrderInFlight && (
          <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl p-3 flex items-start gap-2">
            <AlertTriangle size={12} className="text-yellow-400 mt-0.5 flex-shrink-0" />
            <p className="text-yellow-400 text-[11px]">
              An order is already in flight for this signal (status:{' '}
              <span className="font-bold">{signal.order_status}</span>). Wait for it to fill,
              cancel, or reject before placing another.
            </p>
          </div>
        )}

        {fetchingAccounts ? (
          <div className="flex items-center gap-2 text-subtle text-xs">
            <Loader size={12} className="animate-spin" />
            Loading accounts…
          </div>
        ) : accountsError ? (
          <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-3 text-red-400 text-xs">
            {accountsError}
            <button
              type="button"
              onClick={fetchAccounts}
              className="ml-2 underline hover:text-red-300"
            >
              Retry
            </button>
          </div>
        ) : (
          <div>
            <label className="text-muted text-[10px] uppercase tracking-wider block mb-2">
              Account
            </label>
            <div className="space-y-2">
              {accounts.map((account) => (
                <button
                  key={account.account_number}
                  type="button"
                  onClick={() => {
                    setSelectedAccount(account)
                    setLiveConfirm('')
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-2.5 rounded-xl border text-xs transition-colors',
                    selectedAccount?.account_number === account.account_number
                      ? account.is_paper
                        ? 'border-yellow-500 bg-yellow-950/20 text-white'
                        : 'border-red-500 bg-red-950/20 text-white'
                      : 'border-border text-subtle',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono">{account.account_number}</span>
                    <span className={account.is_paper ? 'text-yellow-400' : 'text-red-400'}>
                      {account.is_paper ? 'Paper' : 'Live'}
                    </span>
                  </div>
                  <div className="flex justify-between mt-1 text-muted">
                    <span>NL: ${fmt$(account.net_liquidating_value)}</span>
                    <span>BP: ${fmt$(account.buying_power)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'idle' && selectedAccount && !existingOrderInFlight && (
          <>
            <div className="bg-bg border border-border rounded-xl p-4">
              <p className="text-muted text-[10px] uppercase tracking-wider mb-3">
                Order Preview
              </p>
              <div className="space-y-2 font-mono text-xs">
                <OrderRow label="Action" value="Buy to Open" color="text-red-400" />
                <OrderRow
                  label="Structure"
                  value={(calculation.structure || '').replace(/_/g, ' ').toUpperCase()}
                />
                <OrderRow label="Ticker" value={signal.ticker} />
                <OrderRow label="Buy Strike" value={`$${calculation.buyStrike}`} highlight />
                <OrderRow label="Sell Strike" value={`$${calculation.sellStrike}`} />
                <OrderRow label="Expiry" value={calculation.expiry || '—'} />
                <OrderRow label="Contracts" value={String(calculation.contracts ?? '—')} highlight />
                <OrderRow label="Limit Price" value={`$${calculation.premium} debit`} />
                <div className="border-t border-border pt-2 mt-2">
                  <OrderRow
                    label="Total Cost"
                    value={`$${calculation.totalCost ?? '—'}`}
                    color="text-red-400"
                  />
                  <OrderRow
                    label="Max Gain"
                    value={`$${calculation.totalMaxGain ?? '—'}`}
                    color="text-green-400"
                  />
                </div>
              </div>
            </div>

            {!selectedAccount.is_paper && (
              <div className="bg-red-950/30 border border-red-800 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-red-400 text-xs font-bold">Live Account Selected</p>
                  <p className="text-zinc-400 text-[10px] mt-0.5">
                    This places a REAL order with REAL money. Switch to paper unless you have
                    completed 90 days of verified paper trading.
                  </p>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setStep('confirm')}
              disabled={!selectedAccount}
              className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900
                         text-white font-semibold rounded-xl py-3 text-sm transition-colors"
            >
              Review &amp; Confirm
            </button>
          </>
        )}

        {step === 'confirm' && selectedAccount && (
          <div className="space-y-4">
            <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl p-4">
              <p className="text-yellow-400 text-sm font-bold mb-2">
                Final Confirmation
              </p>
              <p className="text-zinc-400 text-xs leading-relaxed mb-4">
                {calculation.contracts} contracts of {signal.ticker}{' '}
                {(calculation.structure || '').replace(/_/g, ' ')} at $
                {calculation.premium} debit. Max risk: ${calculation.totalCost}.
              </p>

              <div className="space-y-2 mb-4">
                {[
                  'I have verified the strike prices',
                  'I have verified the expiry date',
                  'Position is within my 2% rule',
                  'I have a pre-planned exit',
                  `Trading on ${selectedAccount.is_paper ? 'paper' : 'LIVE'} account`,
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Check size={12} className="text-green-400 mt-0.5 flex-shrink-0" />
                    <p className="text-zinc-400 text-xs">{item}</p>
                  </div>
                ))}
              </div>

              {!selectedAccount.is_paper && (
                <div className="mb-4">
                  <label className="text-red-400 text-[10px] uppercase tracking-wider block mb-1">
                    Type {LIVE_CONFIRM_PHRASE} to authorise this real-money order
                  </label>
                  <input
                    type="text"
                    value={liveConfirm}
                    onChange={(e) => setLiveConfirm(e.target.value)}
                    placeholder={LIVE_CONFIRM_PHRASE}
                    className="w-full bg-bg border border-red-900 text-white placeholder-zinc-700
                               rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-red-500"
                  />
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setStep('idle')
                    setLiveConfirm('')
                  }}
                  className="flex-1 flex items-center justify-center gap-1 bg-card border border-border
                             text-zinc-400 font-semibold rounded-xl py-2.5 text-sm"
                >
                  <X size={14} />
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitOrder}
                  disabled={loading || !liveConfirmed}
                  className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500
                             disabled:bg-red-950 disabled:text-red-900
                             text-white font-semibold rounded-xl py-2.5 text-sm transition-colors"
                >
                  {loading ? (
                    <>
                      <Loader size={14} className="animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    <>
                      <Check size={14} />
                      Submit Order
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'submitted' && orderResult && (
          <div
            className={clsx(
              'rounded-xl p-4 border',
              orderResult.success
                ? 'bg-green-950/20 border-green-900/40'
                : 'bg-red-950/20 border-red-900/40',
            )}
          >
            {orderResult.success ? (
              <>
                <p className="text-green-400 font-bold text-sm mb-2">
                  ✓ Order Submitted
                </p>
                <div className="space-y-1 font-mono text-xs text-zinc-400">
                  {orderResult.order_id && (
                    <p>
                      Order ID:{' '}
                      <span className="text-white">{orderResult.order_id}</span>
                    </p>
                  )}
                  <p>
                    Status: <span className="text-white">{orderResult.status}</span>
                  </p>
                </div>
                <p className="text-muted text-[10px] mt-2">
                  Limit orders may take time to fill. Verify in your broker.
                </p>
              </>
            ) : (
              (() => {
                const interp = interpretBrokerError(orderResult.error, orderResult.detail)
                return (
                  <>
                    <p className="text-red-400 font-bold text-sm mb-2">
                      {interp.title}
                    </p>
                    <p className="text-zinc-300 text-xs leading-relaxed">
                      {interp.explanation}
                    </p>
                    {interp.suggestion && (
                      <div className="mt-3 pt-3 border-t border-red-900/40">
                        <p className="text-yellow-400 text-[10px] uppercase tracking-wider mb-1">
                          What to do
                        </p>
                        <p className="text-zinc-400 text-xs leading-relaxed">
                          {interp.suggestion}
                        </p>
                      </div>
                    )}
                    <details className="mt-3">
                      <summary className="text-muted text-[10px] cursor-pointer select-none">
                        Raw broker response
                      </summary>
                      <pre className="text-muted text-[10px] mt-2 whitespace-pre-wrap break-all font-mono">
                        {orderResult.detail
                          ? `${orderResult.error}\n\n${orderResult.detail}`
                          : orderResult.error}
                      </pre>
                    </details>
                    <button
                      type="button"
                      onClick={() => setStep('idle')}
                      className="text-red-400 text-xs mt-3 hover:text-red-300"
                    >
                      Try again
                    </button>
                  </>
                )
              })()
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function OrderRow({ label, value, color, highlight }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span
        className={clsx(
          'font-mono',
          color || (highlight ? 'text-white font-bold' : 'text-zinc-400'),
        )}
      >
        {value}
      </span>
    </div>
  )
}

function fmt$(value) {
  if (value == null) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Broker-side rejections come back as opaque preflight error codes.
// Translate the most common ones into plain English with a suggested
// next step so the user knows whether to retry, switch broker, or
// fund the account. Falls back to the raw message when we can't
// pattern-match.
function interpretBrokerError(rawError, rawDetail) {
  let parsed = null
  if (rawDetail) {
    try {
      parsed = typeof rawDetail === 'string' ? JSON.parse(rawDetail) : rawDetail
    } catch {
      /* leave as string */
    }
  }
  const inner = (parsed?.error?.errors && parsed.error.errors[0]) || {}
  const innerCode = inner.code || ''
  const innerMessage = inner.message || parsed?.error?.message || rawError || ''
  const ml = String(innerMessage).toLowerCase()

  if (
    innerCode === 'instrument_validation_failed' ||
    /not supported/.test(ml) ||
    /closing only/.test(ml) ||
    /closing-only/.test(ml)
  ) {
    return {
      title: 'Broker restricted this instrument',
      explanation:
        'Tastytrade has flagged this contract as not currently supported for opening trades. The most common cause is the underlying being marked "closing-only" by the broker — usually due to hard-to-borrow conditions, heavy short interest, or a recent halt.',
      suggestion:
        'Wait it out (usually lifts in days/weeks), try the same trade on a different broker (Robinhood / IBKR may not mirror this restriction), or pick a different ticker from your queue. The signal hash you locked is still valid regardless of where you execute.',
    }
  }

  if (
    /buying power/.test(ml) ||
    /insufficient/.test(ml) ||
    innerCode === 'buying_power_insufficient'
  ) {
    return {
      title: 'Insufficient buying power',
      explanation:
        'Your Tastytrade account does not have enough available buying power to open this position at the size selected.',
      suggestion:
        'Reduce the contract count in the Strike Calculator, transfer funds to the account, or pick a candidate with a smaller premium.',
    }
  }

  if (
    /hard to borrow/.test(ml) ||
    /\bhtb\b/.test(ml) ||
    /not borrowable/.test(ml)
  ) {
    return {
      title: 'Hard to borrow',
      explanation:
        'The underlying stock is currently expensive or unavailable to borrow, which Tastytrade flags before letting you take a position that effectively shorts shares (the short leg of a put spread).',
      suggestion:
        'Same playbook as closing-only: wait, switch broker, or pick a different ticker. Hard-to-borrow can be a confirming bearish signal — but it can also force you to a different platform.',
    }
  }

  if (/strike/.test(ml) && /(invalid|not.*available|not found)/.test(ml)) {
    return {
      title: 'Strike not available',
      explanation:
        'The broker does not have an option contract listed at this strike for the selected expiry. Common for newly-IPO\'d names or thin chains.',
      suggestion:
        'Open the option chain in your broker and pick the closest available strike, then re-run the calculator with the adjusted value.',
    }
  }

  if (/(expir(y|ation))/.test(ml) && /(invalid|not.*available|not found)/.test(ml)) {
    return {
      title: 'Expiry not available',
      explanation:
        'The broker doesn\'t list options for the expiry date you selected. Could be a non-standard date, a holiday-shifted Friday, or a name with quarterly-only expirations.',
      suggestion:
        'Pick a nearby standard expiry (third Friday of the month is the safe default) and update the calculator.',
    }
  }

  if (/order limit/.test(ml) || /position limit/.test(ml)) {
    return {
      title: 'Position limit exceeded',
      explanation:
        'Your account or the broker has a per-position or per-symbol limit that this order would exceed.',
      suggestion:
        'Reduce contract count, or check Tastytrade settings → Trading → Position Limits.',
    }
  }

  if (/market closed/.test(ml) || /outside.*hours/.test(ml)) {
    return {
      title: 'Market closed',
      explanation:
        'Tastytrade only routes options orders during regular market hours (9:30am–4:00pm ET, Mon–Fri).',
      suggestion:
        'Wait for the next session open and resubmit.',
    }
  }

  return {
    title: 'Order rejected',
    explanation: innerMessage || 'The broker rejected this order without a recognised error code.',
    suggestion: null,
  }
}
