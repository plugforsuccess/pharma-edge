import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bell, BellOff, Check, Download, Link2, LogOut, Plus, Trash2, Zap, ShieldCheck, Landmark } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  disablePushNotifications,
  enablePushNotifications,
  pushPermissionStatus,
} from '../utils/pwa'
import clsx from 'clsx'
import NumberInput from '../components/NumberInput'
import BotSettingsSection from '../components/BotSettingsSection'
import { FEATURES } from '../lib/features'
import { FILING_STATUSES, DEFAULT_TARGET_PCTS, EXIT_PLAYBOOK, isValidTaxRate } from '../utils/afterTax'
import { LDP_DISCLOSURES_VERSION, DISCLOSURES, TOLERANCES, EXPERIENCE } from '../lib/ldpDisclosures'

// Settings — the one place users edit their account, LEAPS risk profile,
// tax profile, return goals and Exit Target ladder. One Save button
// persists every changed section:
//   * names (+ leaderboard fields when enabled) → profiles
//   * tax profile + goals + account size → leaps_tax_profiles (own-row RLS)
//   * risk answers, catalyst plays, Exit Target ladder → ldp-onboarding
//     edge function (ldp_risk_profiles is service-role write only; the
//     server recomputes the tier)
// Managed vs self-directed is shown read-only — it follows a signed
// managed-account agreement and is set by the owner, never here.

// Reserved slugs — must match the profiles_public_slug_not_reserved
// CHECK constraint in migration 20260512100000_leaderboard_v1_schema.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'leaderboard', 'login', 'logout',
  'me', 'record', 'settings', 'signup', 'support', 'help',
  'u', 'user', 'users', 'profile', 'profiles', 'www', 'about',
  'privacy', 'terms', 'pricing', 'features', 'blog', 'home',
  'index', 'public', 'static', 'assets', 'favicon',
])

const LADDER_MAX_RUNGS = 5
const CONTACT_EMAIL = 'cameron@cashmoves.io'

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function num(v) {
  if (v === '' || v == null) return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

const pctStr = (x, dp = 4) => (x == null ? '' : String(+(Number(x) * 100).toFixed(dp)))

// ── Form <-> DB mapping ───────────────────────────────────────────

function namesFrom(profile) {
  const dn = (profile?.display_name ?? '').trim()
  const i = dn.indexOf(' ')
  return {
    first_name: i === -1 ? dn : dn.slice(0, i),
    last_name: i === -1 ? '' : dn.slice(i + 1),
    public_slug: profile?.public_slug ?? '',
    is_public: profile?.is_public ?? false,
  }
}

function riskFrom(r, profile) {
  return {
    stated_tolerance: r?.stated_tolerance ?? '',
    options_experience: r?.options_experience ?? '',
    account_size: String(r?.account_size ?? profile?.account_size ?? ''),
    horizon_years: r?.horizon_years != null ? String(r.horizon_years) : '',
    allow_catalyst_plays: !!r?.allow_catalyst_plays,
  }
}

function taxFrom(t) {
  return {
    filing_status: t?.filing_status ?? 'single',
    annual_income: t?.annual_income != null ? String(t.annual_income) : '',
    state_code: t?.state_code ?? '',
    lt_rate_override: pctStr(t?.lt_rate_override),
    st_rate_override: pctStr(t?.st_rate_override),
    pr_act60_rate: t?.pr_act60_rate == null ? 'none' : String(Number(t.pr_act60_rate)),
  }
}

// Puerto Rico Act 60 resident individual investor decree. Decrees
// obtained by 2026-12-31 pay 0% PR tax on post-move gains; applications
// from 2027 pay 4% (Act 38-2026).
const ACT60_OPTIONS = [
  { value: 'none', label: 'No decree' },
  { value: '0', label: '0% — decree by Dec 31, 2026' },
  { value: '0.04', label: '4% — decree from 2027' },
]

// One after-tax return goal; each holding's goal bar solves it on that
// holding's own cost. (target_pcts keeps just this one value.)
function goalsFrom(t) {
  const sel = Number(t?.selected_target_pct)
  return {
    goal: pctStr(sel > 0 ? sel : (t?.target_pcts?.[0] ?? DEFAULT_TARGET_PCTS[0])),
  }
}

// Exit plan (LEAPS playbook): pre-tax gain targets on the option, the
// share of the original position sold at each, and the runner's trail.
function ladderFrom(r) {
  const stored = r?.exit_ladder?.length ? r.exit_ladder.map(Number) : null
  const targets = stored ?? EXIT_PLAYBOOK.targets
  const fr = stored
    ? (r?.rung_fractions?.length === targets.length ? r.rung_fractions.map(Number) : targets.map(() => 1 / targets.length))
    : EXIT_PLAYBOOK.fractions
  const trail = Number(r?.runner_trail_pct)
  return {
    rows: targets.map((t, i) => ({ target: pctStr(t, 2), share: pctStr(fr[i], 2) })),
    trail: pctStr(trail > 0 && trail < 1 ? trail : EXIT_PLAYBOOK.runnerTrailPct, 2),
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export default function Settings() {
  const { user, profile, fetchProfile, signOut } = useAuth()
  const location = useLocation()

  const [loaded, setLoaded] = useState(false)
  const [states, setStates] = useState([])
  const [taxRow, setTaxRow] = useState(null)
  const [riskRow, setRiskRow] = useState(null)

  const [names, setNames] = useState(namesFrom(profile))
  const [risk, setRisk] = useState(riskFrom(null, profile))
  const [tax, setTax] = useState(taxFrom(null))
  const [goals, setGoals] = useState(goalsFrom(null))
  const [ladder, setLadder] = useState(ladderFrom(null))
  const [baseline, setBaseline] = useState(null)
  const [accepted, setAccepted] = useState({})

  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState([])
  const [notice, setNotice] = useState('')

  // ── Load ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      const [t, r, fed] = await Promise.all([
        supabase.from('leaps_tax_profiles').select('*').eq('user_id', user.id).maybeSingle(),
        supabase.from('ldp_risk_profiles').select('*').eq('user_id', user.id).maybeSingle(),
        supabase.from('tax_year_config').select('tax_year').eq('is_current', true).maybeSingle(),
      ])
      if (cancelled) return
      setTaxRow(t.data ?? null)
      setRiskRow(r.data ?? null)
      if (fed.data) {
        const st = await supabase.from('state_tax_rates').select('state_code, state_name')
          .eq('tax_year', fed.data.tax_year).order('state_name')
        if (!cancelled) setStates(st.data ?? [])
      }
      if (!cancelled) setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [user?.id])

  // Reset the form whenever the saved rows change.
  useEffect(() => {
    if (!loaded) return
    const b = {
      names: namesFrom(profile),
      risk: riskFrom(riskRow, profile),
      tax: taxFrom(taxRow),
      goals: goalsFrom(taxRow),
      ladder: ladderFrom(riskRow),
    }
    setNames(b.names); setRisk(b.risk); setTax(b.tax); setGoals(b.goals); setLadder(b.ladder)
    setBaseline(b)
  }, [loaded, taxRow, riskRow, profile?.id, profile?.display_name, profile?.public_slug, profile?.is_public])

  // Deep links: /settings#risk, #tax, #goals, #exit-targets.
  useEffect(() => {
    if (!loaded || !location.hash) return
    const el = document.getElementById(location.hash.slice(1))
    if (el) el.scrollIntoView({ block: 'start' })
  }, [loaded, location.hash])

  const dirty = useMemo(() => baseline && {
    names: !same(names, baseline.names),
    risk: !same({ ...risk, allow_catalyst_plays: undefined }, { ...baseline.risk, allow_catalyst_plays: undefined }),
    catalyst: risk.allow_catalyst_plays !== baseline.risk.allow_catalyst_plays,
    accountSize: risk.account_size !== baseline.risk.account_size,
    tax: !same(tax, baseline.tax),
    goals: !same(goals, baseline.goals),
    ladder: !same(ladder, baseline.ladder),
  }, [baseline, names, risk, tax, goals, ladder])
  const anyDirty = !!dirty && Object.values(dirty).some(Boolean)

  const disclosuresOnFile = riskRow?.disclosures_version === LDP_DISCLOSURES_VERSION
  const needsDisclosures = !!dirty && (dirty.risk || (!riskRow && (dirty.catalyst || dirty.ladder))) && !disclosuresOnFile

  // ── Leaderboard username check (only when the leaderboard is on) ──
  const slugDraft = slugify(names.public_slug)
  const [slugStatus, setSlugStatus] = useState(null)
  useEffect(() => {
    if (!FEATURES.leaderboard || !slugDraft || slugDraft === profile?.public_slug) { setSlugStatus(null); return }
    if (RESERVED_SLUGS.has(slugDraft)) { setSlugStatus('reserved'); return }
    let cancelled = false
    setSlugStatus('checking')
    const t = setTimeout(async () => {
      const { data } = await supabase.from('profiles').select('id').eq('public_slug', slugDraft).maybeSingle()
      if (!cancelled) setSlugStatus(data && data.id !== user?.id ? 'taken' : 'available')
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [slugDraft, profile?.public_slug, user?.id])

  // ── Validation ──────────────────────────────────────────────────
  function needsAnswers() {
    return dirty.risk || (!riskRow && (dirty.catalyst || dirty.ladder))
  }

  function validate() {
    const errs = []
    // Risk answers are required when they changed, or when catalyst /
    // ladder edits need a profile to attach to.
    if (needsAnswers()) {
      if (!risk.stated_tolerance) errs.push('Risk profile: pick a risk tolerance.')
      if (!risk.options_experience) errs.push('Risk profile: pick your options experience.')
      const size = num(risk.account_size)
      if (size == null || size < 0) errs.push('Risk profile: enter your account size.')
      const years = num(risk.horizon_years)
      if (years == null || years < 0 || years > 100) errs.push('Risk profile: enter your time horizon in years.')
      if (needsDisclosures && !DISCLOSURES.every((d) => accepted[d.id])) errs.push('Risk profile: accept each statement to save new answers.')
    }
    if (dirty.tax || dirty.goals || dirty.accountSize) {
      const income = num(tax.annual_income)
      if (income == null || income < 0) errs.push('Tax profile: enter your expected taxable income (0 or more).')
      if (!tax.state_code) errs.push('Tax profile: pick your residency.')
      for (const [k, label] of [['lt_rate_override', 'long-term'], ['st_rate_override', 'short-term']]) {
        const v = num(tax[k])
        if (v != null && !isValidTaxRate(v / 100)) errs.push(`Tax profile: CPA ${label} rate must be between 0% and 99%.`)
      }
      const goal = num(goals.goal)
      if (!(goal > 0 && goal <= 1000)) errs.push('Goals: enter an after-tax return goal above 0%.')
      if (!(num(risk.account_size) > 0) && !taxRow) errs.push('Risk profile: enter your account size (used as your portfolio size).')
    }
    if (dirty.ladder) {
      const t = ladder.rows.map((r) => num(r.target))
      const s = ladder.rows.map((r) => num(r.share))
      const trail = num(ladder.trail)
      if (ladder.rows.length < 1 || ladder.rows.length > LADDER_MAX_RUNGS) errs.push(`Exit Targets: 1 to ${LADDER_MAX_RUNGS} targets.`)
      if (t.some((x) => !(x > 0 && x <= 1000))) errs.push('Exit Targets: each target must be above 0% and at most 1000%.')
      if (t.some((x, i) => i > 0 && !(x > t[i - 1]))) errs.push('Exit Targets: targets must increase from one to the next.')
      if (s.some((x) => !(x > 0))) errs.push('Exit Targets: each target must sell more than 0%.')
      if (s.reduce((a, b) => a + (b || 0), 0) > 100.1) errs.push('Exit Targets: the targets sell more than 100% of the position.')
      if (!(trail >= 5 && trail <= 90)) errs.push('Exit Targets: the runner trail must be between 5% and 90%.')
    }
    if (FEATURES.leaderboard && dirty.names && (slugStatus === 'taken' || slugStatus === 'reserved')) {
      errs.push('Profile: pick a different username.')
    }
    return errs
  }

  // ── Save ────────────────────────────────────────────────────────
  async function save() {
    if (!user?.id || !dirty) return
    setNotice('')
    const errs = validate()
    setErrors(errs)
    if (errs.length) return
    setSaving(true)
    const failures = []
    const prevTier = riskRow?.tier

    // 1. Risk answers / catalyst plays / Exit Target ladder → edge function.
    if (dirty.risk || dirty.catalyst || dirty.ladder) {
      const body = {}
      if (needsAnswers()) {
        body.answers = {
          stated_tolerance: risk.stated_tolerance,
          options_experience: risk.options_experience,
          account_size: num(risk.account_size),
          horizon_years: num(risk.horizon_years),
        }
        if (needsDisclosures) body.disclosures = { version: LDP_DISCLOSURES_VERSION, accepted: true }
      }
      if (dirty.catalyst) body.allow_catalyst_plays = risk.allow_catalyst_plays
      if (dirty.ladder) {
        body.exit_ladder = {
          targets: ladder.rows.map((r) => num(r.target) / 100),
          fractions: ladder.rows.map((r) => num(r.share) / 100),
          runner_trail_pct: num(ladder.trail) / 100,
        }
      }
      const { data, error } = await supabase.functions.invoke('ldp-onboarding', { body })
      if (error || !data?.success) {
        let msg = data?.error
        if (!msg && error?.context?.json) {
          try { msg = (await error.context.json()).error } catch { /* keep generic */ }
        }
        failures.push(msg || 'Could not save your risk profile.')
      } else if (data.profile) {
        setRiskRow((cur) => ({ ...(cur ?? {}), ...data.profile, ...(body.answers ?? {}),
          ...(body.disclosures ? { disclosures_version: LDP_DISCLOSURES_VERSION } : {}) }))
        if (prevTier && data.profile.tier !== prevTier) {
          setNotice(`Your risk tier changed from ${cap(prevTier)} to ${cap(data.profile.tier)}.`)
        }
      }
    }

    // 2. Tax profile + goals (+ account size as portfolio size).
    if (dirty.tax || dirty.goals || dirty.accountSize) {
      const goal = num(goals.goal) / 100
      const lt = num(tax.lt_rate_override)
      const st = num(tax.st_rate_override)
      const size = num(risk.account_size)
      const row = {
        user_id: user.id,
        filing_status: tax.filing_status,
        annual_income: num(tax.annual_income),
        state_code: tax.state_code,
        lt_rate_override: lt == null ? null : lt / 100,
        st_rate_override: st == null ? null : st / 100,
        pr_act60_rate: tax.state_code === 'PR' && tax.pr_act60_rate !== 'none' ? Number(tax.pr_act60_rate) : null,
        target_pcts: [goal],
        selected_target_pct: goal,
        ...(size > 0 ? { portfolio_size: size } : {}),
      }
      const { data, error } = await supabase.from('leaps_tax_profiles').upsert(row).select().single()
      if (error) failures.push(`Could not save your tax profile: ${error.message}`)
      else setTaxRow(data)
    }

    // 3. Names (+ leaderboard fields when enabled).
    if (dirty.names) {
      const displayName = [names.first_name, names.last_name].map((x) => (x || '').trim()).filter(Boolean).join(' ') || null
      const patch = { display_name: displayName }
      if (FEATURES.leaderboard) Object.assign(patch, { public_slug: slugDraft || null, is_public: !!names.is_public })
      const { error } = await supabase.from('profiles').update(patch).eq('id', user.id)
      if (error) failures.push(`Could not save your name: ${error.message}`)
      else await fetchProfile(user.id)
    }

    setSaving(false)
    setErrors(failures)
    setAccepted({})
    if (!failures.length) setNotice((n) => n || 'Saved.')
  }

  const setR = (k, v) => setRisk((x) => ({ ...x, [k]: v }))
  const setT = (k, v) => setTax((x) => ({ ...x, [k]: v }))
  const setG = (k, v) => setGoals((x) => ({ ...x, [k]: v }))

  return (
    <div className="px-4 lg:px-6 pt-6 pb-28 space-y-4 mx-auto lg:max-w-2xl w-full">
      <h1 className="text-fg text-xl lg:text-2xl font-bold tracking-tight">Settings</h1>

      <Section title="Account">
        <p className="text-fg text-sm font-medium break-all">{user?.email}</p>
        <div className="grid grid-cols-2 gap-2">
          <Input label="First name" value={names.first_name} onChange={(v) => setNames((n) => ({ ...n, first_name: v }))} />
          <Input label="Last name" value={names.last_name} onChange={(v) => setNames((n) => ({ ...n, last_name: v }))} />
        </div>
        {FEATURES.leaderboard && (
          <LeaderboardFields names={names} setNames={setNames} slugDraft={slugDraft} slugStatus={slugStatus} />
        )}
      </Section>

      <PlanSection tier={profile?.subscription_tier} />

      <Section title="Risk profile" id="risk">
        <RiskSummary row={riskRow} />
        <ChoiceGroup label="How do you feel about risk?" options={TOLERANCES}
          value={risk.stated_tolerance} onChange={(v) => setR('stated_tolerance', v)} />
        <ChoiceGroup label="Options experience" options={EXPERIENCE}
          value={risk.options_experience} onChange={(v) => setR('options_experience', v)} />
        <div className="grid grid-cols-2 gap-2">
          <Input label="Account size" prefix="$" inputMode="decimal" value={risk.account_size}
            onChange={(v) => setR('account_size', v)} placeholder="100,000" />
          <Input label="Years until you need it" inputMode="decimal" value={risk.horizon_years}
            onChange={(v) => setR('horizon_years', v)} placeholder="5" />
        </div>
        <ToggleRow
          title="Allow catalyst plays"
          body="Let satellites be bought or held right before binary events such as trial readouts or FDA dates."
          value={risk.allow_catalyst_plays}
          onChange={(v) => setR('allow_catalyst_plays', v)}
        />
        {dirty?.risk && (
          <p className="text-[10px] text-amber-300">Saving recalculates your risk tier from these answers.</p>
        )}
        {needsDisclosures && (
          <div className="space-y-2">
            {DISCLOSURES.map((d) => (
              <label key={d.id} className="flex items-start gap-3 bg-bg border border-border rounded-xl p-3 cursor-pointer">
                <input type="checkbox" className="mt-0.5 h-5 w-5 accent-amber-400" checked={!!accepted[d.id]}
                  onChange={(e) => setAccepted((a) => ({ ...a, [d.id]: e.target.checked }))} />
                <span className="text-xs leading-relaxed text-fg">{d.text}</span>
              </label>
            ))}
          </div>
        )}
        <AccountTypeRow row={riskRow} />
      </Section>

      <Section title="Tax profile" id="tax">
        <div className="grid grid-cols-2 gap-2">
          <Select label="Filing status" value={tax.filing_status} onChange={(v) => setT('filing_status', v)}
            options={FILING_STATUSES.map((s) => ({ value: s.value, label: s.label }))} />
          <Select label="Residency" value={tax.state_code} onChange={(v) => setT('state_code', v)}
            options={[{ value: '', label: 'Select…' }, ...states.map((s) => ({ value: s.state_code, label: s.state_name }))]} />
        </div>
        {tax.state_code === 'PR' && (
          <>
            <Select label="Act 60 decree" value={tax.pr_act60_rate} onChange={(v) => setT('pr_act60_rate', v)}
              options={ACT60_OPTIONS} />
            <p className="text-muted text-[10px] leading-relaxed -mt-1">
              As a bona fide Puerto Rico resident, gains on appreciation after your move are excluded from federal
              tax. Appreciation from before the move is still federally taxable.
            </p>
          </>
        )}
        <Input label="Taxable income this year, before LEAPS gains" prefix="$" inputMode="decimal"
          value={tax.annual_income} onChange={(v) => setT('annual_income', v)} placeholder="150,000" />
        <div className="grid grid-cols-2 gap-2">
          <Input label="CPA long-term rate (optional)" suffix="%" inputMode="decimal"
            value={tax.lt_rate_override} onChange={(v) => setT('lt_rate_override', v)} placeholder="Derived" />
          <Input label="CPA short-term rate (optional)" suffix="%" inputMode="decimal"
            value={tax.st_rate_override} onChange={(v) => setT('st_rate_override', v)} placeholder="Derived" />
        </div>
        <p className="text-muted text-[10px] leading-relaxed">
          Used for every after-tax figure and Exit Target. Estimates — consult a tax professional.
        </p>
      </Section>

      <Section title="Goals" id="goals">
        <Input label="Default after-tax return goal (% of what you paid)" suffix="%" inputMode="decimal"
          value={goals.goal} onChange={(v) => setG('goal', v)} placeholder="50" />
      </Section>

      <Section title="Exit Targets" id="exit-targets">
        <LadderEditor plan={ladder} onChange={setLadder} />
      </Section>

      <PushSection userId={user?.id} />

      <Section title="Broker">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-bg border border-border flex items-center justify-center shrink-0">
            <Landmark size={15} className="text-subtle" />
          </div>
          <div className="flex-1">
            <p className="text-fg text-sm font-semibold">Tradier</p>
            <p className="text-subtle text-xs leading-relaxed">
              Coming soon: connect your Tradier account so your positions sync automatically and the bot can trade.
            </p>
          </div>
        </div>
      </Section>
      {FEATURES.tastytradeBroker && <BrokerSection />}

      {FEATURES.legacyBot && profile && (
        <BotSettingsSection profile={profile} onProfileChange={() => fetchProfile?.(user.id)} />
      )}

      <ExportDataButton userId={user?.id} email={user?.email} />

      <button
        type="button"
        onClick={() => signOut()}
        className="w-full flex items-center justify-center gap-2 bg-card border border-border hover:border-red-500 text-fg font-semibold rounded-xl py-3 text-sm transition-colors"
      >
        <LogOut size={14} />
        Sign out
      </button>

      {/* Save bar — always reachable above the mobile nav. */}
      <div className="fixed left-1/2 -translate-x-1/2 w-full max-w-md lg:max-w-2xl px-4 z-40 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] lg:bottom-6">
        {(errors.length > 0 || notice) && (
          <div className={clsx('mb-2 rounded-xl border px-3 py-2 text-xs',
            errors.length ? 'border-red-500/40 bg-red-950/60 text-red-200' : 'border-green-500/30 bg-green-950/60 text-green-200')}
            role={errors.length ? 'alert' : 'status'}>
            {errors.length ? errors.map((e) => <div key={e}>{e}</div>) : notice}
          </div>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving || !anyDirty}
          className={clsx('w-full rounded-xl py-3 text-sm font-semibold transition shadow-lg',
            anyDirty ? 'bg-amber-400 hover:bg-amber-300 text-bg' : 'bg-card border border-border text-muted')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// ── Sections ──────────────────────────────────────────────────────

const TIER_TONE = {
  conservative: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  moderate: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  aggressive: 'bg-red-500/15 text-red-300 border-red-500/40',
}

function RiskSummary({ row }) {
  if (!row) {
    return (
      <p className="text-subtle text-xs leading-relaxed">
        Answer these to set your risk tier. It decides what the LEAPS bot is allowed to buy for you.
      </p>
    )
  }
  const d = row.display ?? {}
  return (
    <div className="rounded-xl border border-border bg-bg p-3">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={14} className="text-amber-400" />
        <span className="text-sm font-semibold flex-1">Your tier</span>
        <span className={clsx('text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold', TIER_TONE[row.tier])}>
          {d.label ?? cap(row.tier)}
        </span>
      </div>
      {d.capped_by_text && <p className="text-subtle text-xs">{d.capped_by_text}</p>}
      {d.allows && <p className="text-fg text-xs leading-relaxed mt-1">{d.allows}</p>}
    </div>
  )
}

function AccountTypeRow({ row }) {
  const managed = row?.account_tier === 'managed'
  return (
    <div className="flex items-start gap-3 border-t border-border pt-3">
      <div className="flex-1">
        <p className="text-fg text-sm font-medium">{managed ? 'Managed account' : 'Self-directed account'}</p>
        <p className="text-subtle text-xs leading-relaxed">
          {managed
            ? 'The bot places trades for you within your risk tier.'
            : 'The bot suggests trades; you place them. Managed accounts require a signed agreement.'}
        </p>
      </div>
      {!managed && (
        <a href={`mailto:${CONTACT_EMAIL}?subject=Managed%20account%20request`}
          className="shrink-0 min-h-[44px] inline-flex items-center px-3 rounded-lg border border-border text-xs text-subtle hover:text-fg hover:border-amber-400/40 transition">
          Request managed
        </a>
      )}
    </div>
  )
}

function PlanSection({ tier }) {
  const isElite = tier === 'elite'
  return (
    <Section title="Plan">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-400/10 border border-amber-400/30 flex items-center justify-center">
          <Zap size={16} className="text-amber-400" />
        </div>
        <div className="flex-1">
          <p className="text-fg text-sm font-semibold">{isElite ? 'Elite' : 'Pro'}</p>
          <p className="text-subtle text-xs">Your current plan</p>
        </div>
      </div>
      <PlanCard name="Pro" price="$45/mo" current={!isElite}
        items={['LEAPS dashboard and positions', 'After-tax Exit Targets', 'Simulator', 'Research']} />
      <PlanCard name="Elite" price="Pricing soon" current={isElite}
        items={['Everything in Pro', 'HeatPulse™ and King Board', 'Bot-placed spread trades']}
        cta={!isElite && { href: `mailto:${CONTACT_EMAIL}?subject=Elite%20interest`, label: 'Get Elite' }} />
    </Section>
  )
}

function PlanCard({ name, price, items, current, cta }) {
  return (
    <div className={clsx('rounded-xl border p-3', current ? 'border-amber-400/40 bg-amber-400/5' : 'border-border bg-bg')}>
      <div className="flex items-baseline justify-between mb-1.5">
        <p className="text-fg text-sm font-semibold">{name}{current && <span className="text-amber-300 text-[10px] ml-2">CURRENT</span>}</p>
        <p className="text-amber-400 text-xs font-display">{price}</p>
      </div>
      <ul className="text-subtle text-xs space-y-1">
        {items.map((i) => <li key={i} className="flex gap-2"><Check size={12} className="text-amber-400 mt-0.5 shrink-0" />{i}</li>)}
      </ul>
      {cta && (
        <a href={cta.href} className="block w-full text-center bg-amber-400 hover:bg-amber-300 text-bg font-semibold rounded-lg py-2 text-xs transition mt-2">
          {cta.label}
        </a>
      )}
    </div>
  )
}

function LadderEditor({ plan, onChange }) {
  const rows = plan.rows
  const setRows = (next) => onChange({ ...plan, rows: next })
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const sold = rows.reduce((a, r) => a + (num(r.share) || 0), 0)
  const runner = Math.max(0, 100 - sold)
  const isPlaybook = JSON.stringify(plan) === JSON.stringify(ladderFrom(null))
  return (
    <div className="space-y-3">
      <p className="text-subtle text-xs">
        Each target sells part of the position once the option is up that much (before tax). Whatever isn't
        sold is the runner, which exits if it falls the trail % from its peak.
      </p>
      <div className="grid grid-cols-[4.25rem_1fr_1fr_2.75rem] gap-2 text-[10px] uppercase tracking-wider text-muted px-1">
        <span />
        <span>Option up</span>
        <span>Sell</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[4.25rem_1fr_1fr_2.75rem] gap-2 items-center">
          <span className="text-xs text-subtle">Target {i + 1}</span>
          <AffixInput value={r.target} onChange={(v) => set(i, 'target', v)} prefix="+" suffix="%" label={`Target ${i + 1} gain on the option`} />
          <AffixInput value={r.share} onChange={(v) => set(i, 'share', v)} suffix="%" label={`Target ${i + 1} share of the position to sell`} />
          <button type="button" aria-label={`Remove target ${i + 1}`} disabled={rows.length <= 1}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            className="min-h-[44px] flex items-center justify-center rounded-lg border border-border text-subtle hover:text-red-300 disabled:opacity-30">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="grid grid-cols-[4.25rem_1fr_1fr_2.75rem] gap-2 items-center">
        <span className="text-xs text-subtle">Runner</span>
        <AffixInput value={plan.trail} onChange={(v) => onChange({ ...plan, trail: v })} suffix="%" label="Runner trail from its peak" />
        <span className={clsx('text-xs font-mono-tab px-1', sold > 100.1 ? 'text-red-300' : 'text-muted')}>
          {sold > 100.1 ? 'over 100%' : `${+runner.toFixed(2)}% left`}
        </span>
        <span />
      </div>
      <p className="text-[10px] text-muted px-1">Runner: exit if it gives back this % from its peak.</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" disabled={rows.length >= LADDER_MAX_RUNGS}
          onClick={() => {
            const last = num(rows[rows.length - 1]?.target) || 0
            setRows([...rows, { target: String(last + 100), share: String(Math.max(0, +(runner / 2).toFixed(2)) || '') }])
          }}
          className="min-h-[44px] px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-xs text-subtle hover:text-fg disabled:opacity-30">
          <Plus size={13} /> Add target
        </button>
        <button type="button" disabled={isPlaybook} onClick={() => onChange(ladderFrom(null))}
          className="min-h-[44px] px-3 rounded-lg border border-border text-xs text-subtle hover:text-fg disabled:opacity-30">
          Reset to playbook
        </button>
      </div>
      <div className="rounded-lg border border-hairline bg-bg/40 px-3 py-2.5 text-xs text-muted space-y-1">
        <div className="text-subtle font-semibold">Also part of the plan</div>
        <div>No hard price stop — cut only if the thesis breaks.</div>
        <div>Roll window at 9 months left; exit or roll at 6.</div>
        <div>Wait for long-term only if it lands before the roll window.</div>
      </div>
    </div>
  )
}

function LeaderboardFields({ names, setNames, slugDraft, slugStatus }) {
  return (
    <>
      <Input label="Username (shown on the leaderboard)" value={names.public_slug}
        onChange={(v) => setNames((n) => ({ ...n, public_slug: v }))} />
      {names.public_slug && slugDraft !== names.public_slug && (
        <p className="text-muted text-[10px]">Will be saved as <span className="font-mono text-zinc-400">{slugDraft || '(empty)'}</span></p>
      )}
      {slugStatus && (
        <p className={clsx('text-[10px] font-medium', {
          'text-muted': slugStatus === 'checking',
          'text-green-400': slugStatus === 'available',
          'text-red-400': slugStatus === 'taken' || slugStatus === 'reserved',
        })}>
          {slugStatus === 'checking' && 'Checking…'}
          {slugStatus === 'available' && '✓ Available'}
          {slugStatus === 'taken' && '✗ Taken — pick a different username'}
          {slugStatus === 'reserved' && '✗ Reserved — pick a different username'}
        </p>
      )}
      <ToggleRow title="Show me on the leaderboard" body="Lists your username and trade stats."
        value={names.is_public} onChange={(v) => setNames((n) => ({ ...n, is_public: v }))} />
    </>
  )
}

// ── Inputs ────────────────────────────────────────────────────────

function Section({ title, id, children }) {
  return (
    <div id={id} className="bg-card border border-border rounded-xl p-4 scroll-mt-4">
      <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-4">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function ChoiceGroup({ label, options, value, onChange }) {
  return (
    <fieldset>
      <legend className="text-muted text-[10px] uppercase tracking-wider mb-1">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value}
            title={o.body}
            className={clsx('min-h-[44px] rounded-lg border px-2 text-xs font-semibold transition',
              value === o.value ? 'border-amber-400/60 bg-amber-400/10 text-amber-300' : 'border-border bg-bg text-subtle hover:text-fg')}>
            {o.label}
          </button>
        ))}
      </div>
      {options.find((o) => o.value === value) && (
        <p className="text-muted text-[10px] mt-1">{options.find((o) => o.value === value).body}</p>
      )}
    </fieldset>
  )
}

function ToggleRow({ title, body, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1">
        <p className="text-fg text-sm font-medium">{title}</p>
        <p className="text-subtle text-xs mt-0.5 leading-relaxed">{body}</p>
      </div>
      <Toggle value={value} onChange={onChange} label={title} />
    </div>
  )
}

function Select({ label, value, onChange, options }) {
  return (
    <div>
      <label className="text-muted text-[10px] uppercase tracking-wider block mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[44px] bg-bg border border-border text-fg rounded-xl px-3 text-sm focus:outline-none focus:border-amber-400/60">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function AffixInput({ value, onChange, prefix, suffix, label }) {
  return (
    <div className="relative">
      {prefix && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-xs">{prefix}</span>}
      <NumberInput value={value} aria-label={label} onChange={onChange}
        className={clsx('w-full min-h-[44px] bg-bg border border-border text-fg rounded-lg text-sm font-mono-tab focus:outline-none focus:border-amber-400/60',
          prefix ? 'pl-6' : 'pl-3', suffix ? 'pr-7' : 'pr-3')} />
      {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted text-xs">{suffix}</span>}
    </div>
  )
}

// One-tap "give me everything you have on me" download. Pulls the
// user's profile, signals, outcomes, order_history and LEAPS rows via the
// authenticated client (RLS scopes to own rows automatically), bundles
// into a JSON file, and triggers a browser download. No edge function
// needed — RLS does the access control on the client SELECT.
//
// Why JSON not CSV: signals carry nested fields (claude_analysis_full,
// signal_scores, source_urls) that flatten badly to CSV. JSON is the
// honest format. Power users can pipe through `jq` if they want CSV.
function ExportDataButton({ userId, email }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function handleExport() {
    if (!userId) return
    setBusy(true)
    try {
      const [profileRes, signalsRes, outcomesRes, ordersRes, taxRes, riskRes, leapsRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
        supabase.from('signals').select('*').eq('user_id', userId).order('logged_at', { ascending: false }),
        supabase.from('outcomes').select('*').eq('user_id', userId).order('recorded_at', { ascending: false }),
        supabase.from('order_history').select('*').eq('user_id', userId).order('id', { ascending: false }),
        supabase.from('leaps_tax_profiles').select('*').eq('user_id', userId).maybeSingle(),
        supabase.from('ldp_risk_profiles').select('*').eq('user_id', userId).maybeSingle(),
        supabase.from('leaps_positions').select('*').eq('user_id', userId).order('purchase_date', { ascending: true }),
      ])
      const bundle = {
        export_metadata: {
          generated_at: new Date().toISOString(),
          generated_for: email || null,
          schema_note:
            'JSON export of every Cash Moves row attached to your account. Hashes match the rows in Cash Moves and the GitHub anchor commits.',
        },
        profile: profileRes.data ?? null,
        signals: signalsRes.data ?? [],
        outcomes: outcomesRes.data ?? [],
        order_history: ordersRes.data ?? [],
        leaps_tax_profile: taxRes.data ?? null,
        leaps_risk_profile: riskRes.data ?? null,
        leaps_positions: leapsRes.data ?? [],
      }
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `cash-moves-export-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setDone(true)
      setTimeout(() => setDone(false), 2000)
    } catch (err) {
      console.error('export failed', err)
      alert('Export failed — try again or contact support.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={busy || !userId}
      className={clsx(
        'w-full flex items-center justify-center gap-2 border rounded-xl py-3 text-sm font-semibold transition-colors',
        done
          ? 'border-green-700 bg-green-950/40 text-green-400'
          : 'bg-card border-border hover:border-amber-400/50 text-white',
      )}
    >
      <Download size={14} />
      {busy ? 'Bundling…' : done ? 'Downloaded ✓' : 'Export My Data (JSON)'}
    </button>
  )
}

const inputClass = (prefix, suffix) => clsx(
  'w-full bg-bg border border-border text-white rounded-xl py-2.5 text-sm focus:outline-none focus:border-amber-400/60 transition-colors',
  prefix ? 'pl-8 pr-4' : suffix ? 'pl-4 pr-8' : 'px-4',
)

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
        {inputMode === 'decimal' || inputMode === 'numeric' || type === 'number' ? (
          <NumberInput
            decimals={inputMode === 'numeric' ? 0 : 2}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            className={inputClass(prefix, suffix)}
          />
        ) : (
          <input
            type={type}
            step={step}
            min={min}
            inputMode={inputMode}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={inputClass(prefix, suffix)}
          />
        )}
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
        value ? 'bg-amber-400' : 'bg-zinc-800',
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
          <p className="text-subtle text-xs leading-relaxed">
            Get position and account alerts on this device as they roll out.
          </p>
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
            Position and account alerts are sent to this device.
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
      if (fnError) {
        // supabase-js wraps non-2xx responses in a generic FunctionsHttpError
        // ("Edge Function returned a non-2xx status code") but the response
        // body has the real failure reason — usually a Tastytrade OAuth
        // error when this fails. Read the body so the user sees something
        // actionable instead of a generic wrapper message.
        let detail = fnError.message || 'request failed'
        try {
          const ctx = fnError.context
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json()
            if (body?.error) detail = body.error
            if (body?.detail) {
              const sub = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
              detail += ` — ${sub.slice(0, 200)}`
            }
          }
        } catch { /* keep the generic message */ }
        throw new Error(detail)
      }
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
            credentials can see. Sandbox base URL by default — switch via TASTYTRADE_BASE_URL
            secret when you're ready for live.
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

