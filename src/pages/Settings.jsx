import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, BellOff, Check, Copy, ExternalLink, Link2, LogOut, Plus, Trash2, Zap } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import {
  disablePushNotifications,
  enablePushNotifications,
  pushPermissionStatus,
} from '../utils/pwa'
import clsx from 'clsx'

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export default function Settings() {
  const { user, profile, fetchProfile, signOut } = useAuth()
  const { tier, isPro } = useSubscription()
  const [form, setForm] = useState(initialForm(profile))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    setForm(initialForm(profile))
  }, [profile?.id])

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const slugDraft = slugify(form.public_slug)
  const publicUrl = slugDraft ? `${window.location.origin}/r/${slugDraft}` : ''
  const accountSizeNum = form.account_size === '' ? null : Number(form.account_size)
  const accountSizeValid =
    accountSizeNum === null || (Number.isFinite(accountSizeNum) && accountSizeNum >= 0)
  const positionPct = Number(form.max_position_pct)
  const sectorPct = Number(form.max_sector_pct)

  async function save() {
    if (!user?.id) return
    if (!accountSizeValid) {
      setError('Account size must be a positive number')
      return
    }
    setError('')
    setSaving(true)

    const update = {
      display_name: form.display_name.trim() || null,
      public_slug: slugDraft || null,
      is_public: !!form.is_public,
      account_size: accountSizeNum,
      max_position_pct: Number.isFinite(positionPct) ? positionPct : 2,
      max_sector_pct: Number.isFinite(sectorPct) ? sectorPct : 20,
    }

    const { error: updateError } = await supabase
      .from('profiles')
      .update(update)
      .eq('id', user.id)

    if (updateError) {
      setError(updateError.message)
    } else {
      await fetchProfile(user.id)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    }
    setSaving(false)
  }

  async function copyPublicUrl() {
    if (!publicUrl) return
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* noop */
    }
  }

  return (
    <div className="px-4 lg:px-6 pt-6 pb-8 space-y-4 mx-auto lg:max-w-2xl w-full">
      <h1 className="text-white text-xl lg:text-2xl font-bold tracking-tight">Settings</h1>

      <Section title="Account">
        <p className="text-white text-sm font-medium break-all">{user?.email}</p>
        {profile?.public_slug && (
          <p className="text-subtle text-xs mt-2 font-mono">/r/{profile.public_slug}</p>
        )}
      </Section>

      <SubscriptionSection tier={tier} isPro={isPro} />

      <Section title="Profile">
        <Input
          label="Display Name"
          value={form.display_name}
          onChange={(v) => update('display_name', v)}
          placeholder="Cameron W."
        />
        <Input
          label="Public URL Slug"
          value={form.public_slug}
          onChange={(v) => update('public_slug', v)}
          placeholder="cameron-wiley"
        />
        {form.public_slug && slugDraft !== form.public_slug && (
          <p className="text-muted text-[10px]">
            Will be saved as <span className="font-mono text-zinc-400">{slugDraft || '(empty)'}</span>
          </p>
        )}
      </Section>

      <Section title="Public Track Record">
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <p className="text-white text-sm font-medium">Public Record Page</p>
            <p className="text-subtle text-xs mt-0.5">
              Anyone with the link can view your signal history.
            </p>
          </div>
          <Toggle
            value={form.is_public}
            onChange={(v) => update('is_public', v)}
            label="Public record visibility"
          />
        </div>

        {form.is_public && publicUrl && (
          <div className="bg-bg border border-border rounded-xl p-3">
            <p className="text-muted text-[10px] uppercase tracking-wider mb-2">Your Public Link</p>
            <div className="flex items-center gap-2">
              <p className="text-zinc-300 text-xs font-mono flex-1 truncate">{publicUrl}</p>
              <button
                type="button"
                onClick={copyPublicUrl}
                className="text-subtle hover:text-white transition-colors flex-shrink-0"
                aria-label="Copy public URL"
              >
                {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
              <a
                href={publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-subtle hover:text-white transition-colors flex-shrink-0"
                aria-label="Open public URL in a new tab"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        )}

        <div className="text-muted text-xs space-y-1">
          <p>✓ Shows: ticker, direction, catalyst date, logged date, outcome, win/loss, hash</p>
          <p>✗ Hides: entry prices, position sizes, personal notes, email</p>
        </div>
      </Section>

      <PushSection userId={user?.id} />

      <WatchlistSection userId={user?.id} />

      <BrokerSection />

      <Section title="Risk Management">
        <Input
          label="Account Size"
          value={form.account_size}
          onChange={(v) => update('account_size', v)}
          type="number"
              inputMode="decimal"
          prefix="$"
          step="any"
          min="0"
        />
        <Input
          label="Max Position Size"
          value={form.max_position_pct}
          onChange={(v) => update('max_position_pct', v)}
          type="number"
              inputMode="decimal"
          suffix="%"
          step="any"
          min="0"
        />
        <Input
          label="Max Sector Exposure"
          value={form.max_sector_pct}
          onChange={(v) => update('max_sector_pct', v)}
          type="number"
              inputMode="decimal"
          suffix="%"
          step="any"
          min="0"
        />

        {accountSizeNum != null && accountSizeValid && (
          <div className="bg-bg border border-border rounded-xl p-3">
            <p className="text-muted text-[10px] uppercase tracking-wider mb-2">
              Calculated Limits
            </p>
            <CalcRow
              label={`Max per trade (${positionPct || 0}%)`}
              value={`$${((accountSizeNum * (positionPct || 0)) / 100).toLocaleString()}`}
              valueClass="text-red-400"
            />
            <CalcRow
              label={`Max sector total (${sectorPct || 0}%)`}
              value={`$${((accountSizeNum * (sectorPct || 0)) / 100).toLocaleString()}`}
              valueClass="text-yellow-400"
            />
          </div>
        )}
      </Section>

      {error && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3">
          <p className="text-red-400 text-xs" role="alert">
            {error}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-950 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
      >
        {saving ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save Settings'}
      </button>

      <button
        type="button"
        onClick={() => signOut()}
        className="w-full flex items-center justify-center gap-2 bg-card border border-border
                   hover:border-red-500 text-white font-semibold rounded-xl py-3 text-sm
                   transition-colors"
      >
        <LogOut size={14} />
        Sign Out
      </button>
    </div>
  )
}

function initialForm(profile) {
  return {
    display_name: profile?.display_name ?? '',
    public_slug: profile?.public_slug ?? '',
    is_public: profile?.is_public ?? true,
    account_size: profile?.account_size != null ? String(profile.account_size) : '',
    max_position_pct: profile?.max_position_pct != null ? String(profile.max_position_pct) : '2',
    max_sector_pct: profile?.max_sector_pct != null ? String(profile.max_sector_pct) : '20',
  }
}

function Section({ title, children }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-4">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

// Tier card. Shows current plan and either confirms Pro or pitches the
// upgrade. The "Go Pro" button doesn't open Stripe yet — that wires up
// once the Stripe webhook + checkout edge function ship. For now it
// just opens a mailto so a user can flag interest.
function SubscriptionSection({ tier, isPro }) {
  return (
    <Section title="Subscription">
      {isPro ? (
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-400/10 border border-amber-400/30 flex items-center justify-center">
            <Zap size={16} className="text-amber-400" />
          </div>
          <div className="flex-1">
            <p className="text-white text-sm font-semibold">Cash Moves Pro</p>
            <p className="text-subtle text-xs">
              Full Gamma Map, Flow, Suggested Plays, broker execution, and full move analytics.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-lg bg-bg border border-border flex items-center justify-center">
              <span className="text-subtle text-xs font-semibold">F</span>
            </div>
            <div className="flex-1">
              <p className="text-white text-sm font-semibold">Free</p>
              <p className="text-subtle text-xs">
                3 Gamma Map tickers · read-only public records.
              </p>
            </div>
          </div>

          <div className="bg-bg border border-amber-400/20 rounded-lg p-3 space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-white text-sm font-semibold">Cash Moves Pro</p>
              <p className="text-amber-400 text-sm font-display">
                $39<span className="text-xs text-subtle">/mo</span>
              </p>
            </div>
            <ul className="text-subtle text-xs space-y-1 list-disc list-inside">
              <li>Full Gamma Map ticker list + watchlist</li>
              <li>Live options Flow + UOA detection</li>
              <li>Suggested Plays (GEX-driven spread setups)</li>
              <li>Tastytrade execution</li>
              <li>Hash-anchored public track record</li>
            </ul>
            <a
              href="mailto:cameron@cashmoves.io?subject=Cash%20Moves%20Pro%20interest"
              className="block w-full text-center bg-amber-400 hover:bg-amber-300 text-bg font-semibold rounded-lg py-2 text-xs transition mt-1"
            >
              Go Pro
            </a>
            <p className="text-muted text-[10px] text-center">
              Tier: <span className="font-mono">{tier}</span>
            </p>
          </div>
        </>
      )}
    </Section>
  )
}

function Input({ label, value, onChange, placeholder, type = 'text', prefix, suffix, step, min, inputMode }) {
  return (
    <div>
      <label className="text-muted text-[10px] uppercase tracking-wider block mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">
            {prefix}
          </span>
        )}
        <input
          type={type}
          step={step}
          min={min}
          inputMode={inputMode || (type === 'number' ? 'decimal' : undefined)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={clsx(
            'w-full bg-bg border border-border text-white rounded-xl py-2.5 text-sm focus:outline-none focus:border-red-500 transition-colors',
            prefix ? 'pl-8 pr-4' : suffix ? 'pl-4 pr-8' : 'px-4',
          )}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-xs">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}

function Toggle({ value, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={clsx(
        'w-12 h-6 rounded-full transition-colors relative flex-shrink-0',
        value ? 'bg-red-600' : 'bg-zinc-800',
      )}
    >
      <div
        className={clsx(
          'w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform',
          value ? 'translate-x-6' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function PushSection({ userId }) {
  const [permission, setPermission] = useState('default')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    setPermission(pushPermissionStatus())
  }, [])

  if (permission === 'unsupported') {
    return (
      <Section title="Push Notifications">
        <p className="text-subtle text-xs">
          This browser doesn't support push notifications. iOS users can still install the
          app to the home screen for native badging.
        </p>
      </Section>
    )
  }

  async function enable() {
    setBusy(true)
    setFeedback('')
    const result = await enablePushNotifications(userId)
    setBusy(false)
    setPermission(pushPermissionStatus())
    setFeedback(
      {
        enabled: 'Push notifications enabled.',
        denied: 'Permission denied. Re-enable in browser settings.',
        'no-vapid': 'VAPID public key not configured for this deploy.',
        'no-sw': 'Service worker not yet registered. Reload and try again.',
        unsupported: 'Browser does not support push.',
        failed: 'Could not enable push. See console.',
      }[result] || result,
    )
  }

  async function disable() {
    setBusy(true)
    setFeedback('')
    await disablePushNotifications()
    setBusy(false)
    setFeedback('Push notifications disabled.')
  }

  const isEnabled = permission === 'granted'

  // When push is off, present it as a one-tap CTA card with a value
  // pitch — most users won't dig into a small button. When already
  // enabled we shrink back to a compact status row.
  if (!isEnabled) {
    return (
      <Section title="Push Notifications">
        <div className="bg-gradient-to-br from-amber-950/40 to-bg-elev/40 border border-amber-400/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-400/15 flex items-center justify-center">
              <Bell size={15} className="text-amber-400" />
            </div>
            <p className="text-fg text-sm font-semibold">Stay in the loop</p>
          </div>
          <ul className="text-subtle text-xs leading-relaxed space-y-1 list-disc pl-4">
            <li>Catalyst reminders 14d / 7d / 1d before resolution</li>
            <li>Stop-loss alerts when an open position hits −50%</li>
            <li>Profit-take alerts at +50% / +100% / +200%</li>
            <li>DTE warning when expiry is ≤ 21 days</li>
          </ul>
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-bg text-sm font-semibold rounded-xl px-3 py-2.5 transition-colors"
          >
            <Bell size={14} />
            {busy ? 'Enabling…' : 'Enable Push Alerts'}
          </button>
          {feedback && <p className="text-subtle text-xs">{feedback}</p>}
        </div>
      </Section>
    )
  }

  return (
    <Section title="Push Notifications">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">Enabled</p>
          <p className="text-subtle text-xs mt-0.5">
            Catalyst + position alerts sent to this device alongside email.
          </p>
        </div>
        <button
          type="button"
          onClick={disable}
          disabled={busy}
          className="flex items-center gap-2 bg-card border border-border hover:border-red-500
                     text-white text-sm font-semibold rounded-xl px-3 py-2 transition-colors disabled:opacity-50"
        >
          <BellOff size={14} />
          Disable
        </button>
      </div>
      {feedback && <p className="text-subtle text-xs">{feedback}</p>}
    </Section>
  )
}

function WatchlistSection({ userId }) {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [ticker, setTicker] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!userId) return
    const { data } = await supabase
      .from('watchlist')
      .select('id, ticker, company_name, drug_name, added_at')
      .eq('user_id', userId)
      .order('added_at', { ascending: false })
    setItems(data ?? [])
  }, [userId])

  useEffect(() => {
    load()
  }, [load])

  async function add(e) {
    e?.preventDefault?.()
    if (!userId) return
    const t = ticker.trim().toUpperCase()
    const c = companyName.trim()
    if (!t || !c) {
      setError('Ticker and company name are both required')
      return
    }
    setBusy(true)
    setError('')
    const { error: insertError } = await supabase.from('watchlist').insert({
      user_id: userId,
      ticker: t,
      company_name: c,
    })
    setBusy(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setTicker('')
    setCompanyName('')
    load()
  }

  async function remove(id) {
    if (!userId) return
    setBusy(true)
    await supabase.from('watchlist').delete().eq('id', id).eq('user_id', userId)
    setBusy(false)
    load()
  }

  function openLogForTicker(item) {
    navigate('/log', {
      state: {
        prefill: {
          ticker: item.ticker,
          company_name: item.company_name,
          drug_name: item.drug_name || '',
        },
      },
    })
  }

  return (
    <Section title="My Tickers (Watchlist)">
      <p className="text-subtle text-xs">
        Tickers here get scraped daily at 7am ET — any new SEC filing, CT.gov trial, or FDA
        press release shows up as a personal candidate in the scanner queue. Tap a row to open
        a pre-filled signal log.
      </p>

      <form onSubmit={add} className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="ALDX"
          maxLength={10}
          className="bg-bg border border-border text-white placeholder-zinc-700 rounded-xl
                     px-3 py-2 text-sm focus:outline-none focus:border-red-500 font-mono"
        />
        <input
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="Aldeyra Therapeutics"
          className="bg-bg border border-border text-white placeholder-zinc-700 rounded-xl
                     px-3 py-2 text-sm focus:outline-none focus:border-red-500"
        />
        <button
          type="submit"
          disabled={busy || !ticker || !companyName}
          className="col-span-2 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500
                     disabled:bg-red-950 disabled:text-red-900 text-white font-semibold
                     rounded-xl py-2 text-sm transition-colors"
        >
          <Plus size={14} />
          Add to Watchlist
        </button>
      </form>

      {error && (
        <p className="text-red-400 text-xs" role="alert">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-muted text-xs italic">No tickers yet. Add one above.</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 bg-bg border border-border rounded-lg px-3 py-2"
            >
              <button
                type="button"
                onClick={() => openLogForTicker(item)}
                className="flex-1 text-left"
                aria-label={`Log signal for ${item.ticker}`}
              >
                <p className="text-white font-mono text-sm">{item.ticker}</p>
                <p className="text-subtle text-[10px] truncate">{item.company_name}</p>
              </button>
              <button
                type="button"
                onClick={() => remove(item.id)}
                disabled={busy}
                aria-label={`Remove ${item.ticker} from watchlist`}
                className="text-muted hover:text-red-400 transition-colors p-1"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function BrokerSection() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  async function testConnection() {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('get-account')
      if (fnError) throw fnError
      if (!data?.success) {
        setError(data?.error || 'Connection failed')
      } else {
        setResult(data)
      }
    } catch (e) {
      setError(e.message || 'Request failed')
    }
    setBusy(false)
  }

  return (
    <Section title="Broker Connection (Tastytrade)">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">Test connection</p>
          <p className="text-subtle text-xs mt-0.5">
            Calls <span className="font-mono">get-account</span>. Lists accounts the bot's
            credentials can see. Sandbox base URL by default — switch only after 90 days of
            paper.
          </p>
        </div>
        <button
          type="button"
          onClick={testConnection}
          disabled={busy}
          className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:bg-red-950
                     text-white text-sm font-semibold rounded-xl px-3 py-2 transition-colors"
        >
          <Link2 size={14} />
          {busy ? 'Testing…' : 'Test'}
        </button>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3">
          <p className="text-red-400 text-xs break-all" role="alert">
            {error}
          </p>
        </div>
      )}

      {result && (
        <div className="bg-bg border border-border rounded-xl p-3">
          <p className="text-muted text-[10px] uppercase tracking-wider mb-2">
            Accounts ({result.accounts?.length ?? 0})
          </p>
          {(!result.accounts || result.accounts.length === 0) && (
            <p className="text-subtle text-xs">
              No accounts returned. Add a customer profile in the Tastytrade sandbox
              dashboard (developer.tastytrade.com/sandbox) before this returns data.
            </p>
          )}
          <div className="space-y-2">
            {(result.accounts ?? []).map((acc) => (
              <div
                key={acc.account_number}
                className="flex items-center justify-between text-xs font-mono"
              >
                <div>
                  <p className="text-white">{acc.account_number}</p>
                  <p className="text-muted text-[10px]">{acc.account_type ?? 'account'}</p>
                </div>
                <div className="text-right">
                  <p
                    className={
                      acc.is_paper ? 'text-yellow-400 text-[10px]' : 'text-red-400 text-[10px]'
                    }
                  >
                    {acc.is_paper ? 'PAPER' : 'LIVE'}
                  </p>
                  <p className="text-zinc-400">
                    NL ${Number(acc.net_liquidating_value || 0).toLocaleString()}
                  </p>
                  <p className="text-muted text-[10px]">
                    BP ${Number(acc.buying_power || 0).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

function CalcRow({ label, value, valueClass }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-subtle text-xs">{label}</p>
      <p className={clsx('text-xs font-bold', valueClass)}>{value}</p>
    </div>
  )
}
