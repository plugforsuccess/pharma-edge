import { useEffect, useState } from 'react'
import { Bell, BellOff, Check, Copy, ExternalLink, Link2, LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
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
    <div className="px-4 pt-6 pb-8 space-y-4">
      <h1 className="text-white text-xl font-bold tracking-tight">Settings</h1>

      <Section title="Account">
        <p className="text-white text-sm font-medium break-all">{user?.email}</p>
        {profile?.public_slug && (
          <p className="text-subtle text-xs mt-2 font-mono">/r/{profile.public_slug}</p>
        )}
      </Section>

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
          placeholder="cameron-pharma-edge"
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

      <BrokerSection />

      <Section title="Risk Management">
        <Input
          label="Account Size"
          value={form.account_size}
          onChange={(v) => update('account_size', v)}
          type="number"
          prefix="$"
          step="any"
          min="0"
        />
        <Input
          label="Max Position Size"
          value={form.max_position_pct}
          onChange={(v) => update('max_position_pct', v)}
          type="number"
          suffix="%"
          step="any"
          min="0"
        />
        <Input
          label="Max Sector Exposure"
          value={form.max_sector_pct}
          onChange={(v) => update('max_sector_pct', v)}
          type="number"
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

function Input({ label, value, onChange, placeholder, type = 'text', prefix, suffix, step, min }) {
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

  return (
    <Section title="Push Notifications">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">
            {isEnabled ? 'Enabled' : 'Off'}
          </p>
          <p className="text-subtle text-xs mt-0.5">
            Catalyst reminders + outcome reminders sent to this device alongside email.
          </p>
        </div>
        {isEnabled ? (
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
        ) : (
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:bg-red-950
                       text-white text-sm font-semibold rounded-xl px-3 py-2 transition-colors"
          >
            <Bell size={14} />
            Enable
          </button>
        )}
      </div>
      {feedback && <p className="text-subtle text-xs">{feedback}</p>}
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
