# AUTO_TRADE_MANAGEMENT.md — Cash Moves Auto-Trade Spec

> Full spec for the automated trade-management system. Covers Phase 1
> (semi-auto, shipped), Phase 1.5 (partial closes + thesis triggers,
> shipped), and Phase 2 (autonomous execution, planned).
>
> Companion to `CLAUDE.md` (project conventions) and `RISK_MANAGEMENT.md`
> (the trading rule book the system enforces). Read those first if you
> haven't.

---

## 1. What this system is

The Cash Moves automated trade-management layer watches every open
position during US RTH and proposes a closing order whenever the
position trips one of the playbook's exit rules. The playbook is
encoded as a small, additive set of triggers:

| Trigger | Fires when | Action |
|---|---|---|
| `stop_loss_50` | Live P&L ≤ −50% | Close **all** remaining contracts |
| `profit_take_100` | Live P&L ≥ +100% | Close **50%** of remaining (let runner ride) |
| `profit_take_200` | Live P&L ≥ +200% | Close **75%** of remaining (let 25% expire) |
| `thesis_invalidated` | Cached verdict = `invalidated` (≤30 min stale) | Close **all** remaining contracts |

Each trigger fires at most once per `(position, kind)` while
`status='pending'`. When the user dismisses or the order executes, a
future eval can re-create a trigger of the same kind on the next
threshold crossing.

### Operating mode

* **Phase 1 (shipped):** Server detects → writes proposed action → push
  notification → user opens app → one-tap "Close all" / "Scale out
  3/6" → close-order submits to Tastytrade. User stays in the loop.
* **Phase 2 (planned):** Same server detection, but instead of writing
  to `auto_triggers` for user approval, trigger-eval calls
  `close-order` directly. Gated by a per-user kill switch + a
  max-trades-per-day guard. **Not enabled until 2-4 weeks of phase 1
  logs are reviewed.**

The system is **not a hedge-fund robo-advisor.** It is a signal +
execution shortcut for a single trader's own account. See §11 for the
legal / regulatory posture.

---

## 2. End-to-end loop (current state)

```
                       ┌───────────────────────────────┐
                       │  monitor-positions cron       │
                       │  (every 5 min, RTH only)      │
                       └─────────────┬─────────────────┘
                                     │ writes
                                     ▼
                     ┌─────────────────────────────────┐
                     │  open_positions.last_verdict     │
                     │  open_positions.last_polled_at   │
                     │  open_positions.last_pnl_pct     │
                     └─────────────┬───────────────────┘
                                     │ reads
                                     ▼
                       ┌───────────────────────────────┐
                       │  trigger-eval cron             │
                       │  (every 5 min, RTH only)       │
                       │                                │
                       │  Per position:                 │
                       │   1. read last_verdict         │
                       │      → fire thesis_invalidated │
                       │   2. compute live P&L from     │
                       │      dxlink_quotes leg mids    │
                       │      → fire stop / profit      │
                       │   3. fan out push notifs       │
                       └─────────────┬─────────────────┘
                                     │ writes
                                     ▼
                     ┌───────────────────────────────────┐
                     │  auto_triggers (pending row)       │
                     │  + push_subscriptions (delivery)   │
                     └─────────────┬─────────────────────┘
                                     │ realtime sub
                                     ▼
                       ┌───────────────────────────────┐
                       │  PositionDetail (client)       │
                       │  AutoTriggersCard renders      │
                       │  red/amber banner              │
                       └─────────────┬─────────────────┘
                                     │ user taps "Close all"
                                     ▼
                       ┌───────────────────────────────┐
                       │  close-order edge function     │
                       │  → Tastytrade order            │
                       │  → order_history row           │
                       │  → marks trigger 'executed'    │
                       └─────────────┬─────────────────┘
                                     │ broker fills
                                     ▼
                       ┌───────────────────────────────┐
                       │  monitor-positions next tick   │
                       │  → decrements contracts_remaining
                       │  → DB trigger flips status      │
                       │     to 'closed' on 0           │
                       └───────────────────────────────┘
```

**Worst-case latency from "thesis breaks" to "user gets push":**
~10 minutes (one monitor-positions tick + one trigger-eval tick on
overlapping 5-minute crons).

---

## 3. Database schema

### 3.1 `auto_triggers` (new in Phase 1)

```sql
auto_triggers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id     uuid NOT NULL REFERENCES open_positions(id) ON DELETE CASCADE,
  signal_id       uuid REFERENCES signals(id),
  kind            text NOT NULL CHECK (kind IN (
                    'stop_loss_50',
                    'profit_take_100',
                    'profit_take_200',
                    'thesis_invalidated'
                  )),
  reason          text NOT NULL,
  proposed_action jsonb NOT NULL,
  observed        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending','approved','executed','failed',
                    'dismissed','expired'
                  )),
  execution_result jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  executed_at     timestamptz,
  resolved_at     timestamptz
);

-- Idempotency: at most one PENDING trigger per (position, kind)
CREATE UNIQUE INDEX auto_triggers_unique_pending
  ON auto_triggers (position_id, kind) WHERE status = 'pending';

-- RLS
auto_triggers_select_own:     authenticated SELECT where user_id = auth.uid()
auto_triggers_select_admin:   authenticated SELECT where is_admin()
auto_triggers_update_dismiss: authenticated UPDATE OWN, only when transitioning
                              pending → dismissed (clients can dismiss but
                              cannot approve/execute — that's service-role)
```

**Status state machine:**

```
                       ┌──────────────┐
                       │   pending    │  ← trigger-eval insert
                       └──────┬───────┘
                              │
                  ┌───────────┼───────────┐
                  ▼           ▼           ▼
            ┌──────────┐ ┌─────────┐ ┌──────────┐
            │ approved │ │ dismissed│ │ expired  │
            │ (by      │ │ (by user)│ │ (TODO:   │
            │ close-   │ │           │ │ cron at  │
            │ order)   │ │           │ │ EOD)     │
            └────┬─────┘ └──────────┘ └──────────┘
                 │
       ┌─────────┼─────────┐
       ▼                   ▼
 ┌──────────┐         ┌────────┐
 │ executed │         │ failed │
 └──────────┘         └────────┘
```

### 3.2 `open_positions` (extended in Phase 1 / 1.5)

| Column | Added in | Role |
|---|---|---|
| `contracts` | original | Immutable original contract count at entry |
| `contracts_remaining` | Phase 1.5 | Live count; decremented by close fills. BEFORE-UPDATE trigger flips `status='closed'` when this hits 0 |
| `last_verdict` | Phase 3a (verdict) | `intact` / `drifting` / `invalidated` / `not_evaluable` — cached by monitor-positions |
| `last_verdict_reasons` | Phase 3a | Array of human-readable reasons |
| `last_verdict_at` | Phase 3a | Timestamp of cached verdict; trigger-eval ignores if >30 min stale |
| `last_pnl_pct` | original | Updated by monitor-positions on each poll; fallback for P&L when dxlink quotes are stale |
| `last_mid_per_spread` | original | Broker-polled spread mid; fallback for `limit_price` |

### 3.3 `order_history` (extended in Phase 1)

| Column | Added in | Role |
|---|---|---|
| `position_id` | Phase 1 | Required for close-order idempotency check ("is a close already in flight for this position?") |
| `order_type` | original | `open` or `close` |
| `auto_executed` | reserved for Phase 2 | True when an autonomous close fired without user tap |
| `auto_close_strategy` | reserved | The trigger kind that fired (`stop_loss_50` etc.) |

### 3.4 `signals` (existing — drives the verdict)

The verdict reads these fields to know what the trade was structurally
betting on:

| Column | Role |
|---|---|
| `entry_gex_snapshot` | jsonb capture of spot + net_gex + largest_wall at lock time |
| `target_king_node` | `call_wall` / `put_wall` / `flip` |
| `target_strike` | The specific strike the trade was anchored to |
| `target_expiration` | The expiration of the anchor wall (may differ from trade expiry) |
| `target_thesis_kind` | `pin_to` / `break_through` / `fade` |
| `regime_at_entry` | `A` / `B` / `mixed` |

These are populated at LogSignal time and are immutable post-entry per
the signal-immutability contract in CLAUDE.md.

---

## 4. Edge functions

### 4.1 `trigger-eval`

* **Auth:** service-role only (validates JWT, rejects anything that
  isn't `role: service_role`).
* **Trigger:** cron from `.github/workflows/trigger-eval.yml`.
* **Schedule:** `35,40,45,50,55 13 * * 1-5` and `*/5 14-20 * * 1-5`
  UTC — equivalent to every 5 min during US RTH, DST-safe via Intl in
  the function body.
* **Off-hours:** Returns `{ skipped: 'outside RTH' }` unless body has
  `force: true` (for dev-time wiring tests).
* **Loop:** For every `open_positions WHERE status='open'`:
  1. **`thesis_invalidated` rule.** If `last_verdict='invalidated'` and
     `last_verdict_at` ≤30 min old, fire. Limit price falls back from
     live dxlink mid → last broker poll → defer.
  2. **`stop_loss_50` / `profit_take_*` rules.** Compute live P&L from
     `dxlink_quotes` leg mids. Skip if either leg is missing or
     >5 min stale, or strategy is a credit spread (sign convention
     not yet unified). Highest-severity rule wins.
* **Sizing:** All triggers scale against `contracts_remaining`, not
  the original `contracts`. A second profit-take after a scale-out
  doesn't accidentally close more than the runner has left.
* **Idempotency:** Partial unique index on `(position_id, kind) WHERE
  status='pending'`. Insert errors with code `23505` are silently
  counted in the response summary.
* **Push fan-out:** On each trigger insert, sends web-push to every
  `push_subscriptions` row for the user. Deep-links to
  `/position/<id>?trigger=<id>`.

### 4.2 `close-order`

* **Auth:** verify_jwt=true, derives user_id from the validated JWT.
* **Request body:**
  ```json
  {
    "position_id": "uuid",
    "account_number": "string (Tastytrade account)",
    "contracts": 3,
    "limit_price": 4.50,
    "trigger_id": "uuid (optional — when invoked from AutoTriggersCard)"
  }
  ```
* **Validation:**
  * Position exists, belongs to user, `status='open'`.
  * `contracts ≤ pos.contracts_remaining` (not `≤ contracts`).
  * No other close order in flight for the same `position_id` (refuses
    with 409).
* **Order build:**
  * Debit spreads (bull call / bear put): `price-effect: Credit`,
    legs = `Sell to Close (long_strike)` + `Buy to Close (short_strike)`.
  * Credit spreads (bull put credit / bear call credit):
    `price-effect: Debit`, same leg actions.
* **Trigger handoff:** If `trigger_id` is present:
  * Before broker call: `auto_triggers.status = 'approved'`.
  * On success: `'executed'`, `executed_at = now()`, `resolved_at = now()`.
  * On failure: `'failed'`, `resolved_at = now()`, plus
    `execution_result` jsonb.
* **Does NOT** decrement `contracts_remaining` on submit. That's
  monitor-positions' job once the fill confirms (pre-fill decrement
  desyncs on rejection).

### 4.3 `monitor-positions` (extended in Phase 1.5)

* **Existing role:** polls Tastytrade for fill status on open orders,
  computes the verdict via `thesisVerdict.ts`, sends transition push
  alerts.
* **New in Phase 1.5:** when a `close` order transitions to `filled`,
  decrements `open_positions.contracts_remaining` by the order's
  contracts. DB trigger `open_positions_close_on_zero_remaining` then
  flips `status='closed'` automatically.
* **`partial_fill` rows:** deliberately no-op. Tastytrade Day orders
  terminate to `filled` or `cancelled`; the decrement happens at the
  terminal state. User-cancels-mid-partial is a phase-2 edge case that
  needs `filled-quantity` polling.

### 4.4 `worker-health` (dead-man switch — adjacent)

Independent dead-man switch added in PR #126. Detects when
`dxlink_quotes` or `monitor-positions` go stale (>15 min or >30 min
respectively, during RTH) and emails the admin with a 60-min cooldown.

Not part of the trade-management flow per se, but it's what tells you
when the inputs to trigger-eval (live quotes + cached verdict) have
gone dark.

---

## 5. UI surfaces

### 5.1 `AutoTriggersCard` (PositionDetail)

* Mounted directly under the page header, above the Live P&L card.
* Subscribes to `auto_triggers` realtime filtered by `position_id`.
  New pending rows appear instantly; executed/dismissed/expired rows
  vanish instantly.
* Hidden entirely when no pending triggers exist.
* Each row renders:

```
┌──────────────────────────────────────────────────────────────┐
│ STOP LOSS TRIPPED                                  P&L −52% │
│                                                              │
│ P&L hit -52% (threshold -50%). Cash Moves rule: exit         │
│ immediately.                                                 │
│                                                              │
│ ┌─────────────────────────┐  ┌──────────────────────────┐  │
│ │     Close all            │  │       Dismiss            │  │
│ └─────────────────────────┘  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

* **Tone:** Crimson for `stop_loss_50` and `thesis_invalidated`
  (protect-capital events). Amber for `profit_take_*` (good news,
  still action-required).
* **Button label:**
  * `Close all` when `proposed_action.contracts ===
    contracts_remaining_at_trip`.
  * `Scale out X/Y` for partial closes (X = proposed, Y = remaining
    at trip time).
* **Approve flow:** fetches the user's broker account via
  `get-account` (largest non-paper preferred), refreshes
  `limit_price` from the live legGreeks mid if newer than the
  trigger's snapshot, POSTs to `close-order` with `trigger_id` so
  close-order can mark the row.
* **Dismiss flow:** client UPDATE on the row to `status='dismissed'`.
  RLS allows this transition only when current status is `pending`.

### 5.2 Push notifications

Sent by `trigger-eval` on every new trigger. Standard PWA push:

```json
{
  "title": "QQQ: stop loss tripped",
  "body": "P&L hit -52% (threshold -50%). Cash Moves rule: exit immediately.",
  "url": "/position/<position_id>?trigger=<trigger_id>"
}
```

Deep link opens PositionDetail with the trigger pre-scrolled into
view. (The `?trigger=` param is currently informational only — no
auto-confirm modal yet. See §10.)

### 5.3 Position header subtitle

Shows `"X of Y contracts"` when `contracts_remaining < contracts`,
otherwise `"N contracts"`. Makes it visible at a glance that a
partial close has happened.

---

## 6. The rule book

### 6.1 `stop_loss_50`

* **Threshold:** Live P&L ≤ −50%.
* **Source:** Computed in trigger-eval from streaming dxlink_quotes
  leg mids. Stale-quote guard: >5 min old → skip eval (not trip).
* **Action proposed:** Close `contracts_remaining` (full exit).
* **Rationale:** Cash Moves rule. The thesis is wrong OR the entry
  was timed wrong; either way, capital preservation > recovery hope.

### 6.2 `profit_take_100`

* **Threshold:** Live P&L ≥ +100%.
* **Source:** Same as above.
* **Action proposed:** `ceil(contracts_remaining * 0.5)` (scale out
  50%, let the runner ride).
* **Rationale:** Lock in a 2:1 R/R win; the remaining 50% has a free
  ride toward +200%.

### 6.3 `profit_take_200`

* **Threshold:** Live P&L ≥ +200%.
* **Source:** Same as above.
* **Action proposed:** `ceil(contracts_remaining * 0.75)` (scale out
  75% of the remainder; let 25% expire toward max profit).
* **Rationale:** 3:1+ R/R win on the scaled lot; the final 25% is the
  "let it run to max" allocation. Total locked-in profit is meaningful
  even if the final 25% goes to zero.

### 6.4 `thesis_invalidated`

* **Threshold:** `open_positions.last_verdict = 'invalidated'`, with
  `last_verdict_at ≤ 30 min` stale.
* **Source:** Cached by `monitor-positions` every 5 min using
  `supabase/functions/monitor-positions/thesisVerdict.ts`. Same
  algorithm the client UI banner displays — guaranteed to agree by
  shared logic.
* **Action proposed:** Close `contracts_remaining` (full exit).
* **Rationale:** The trade was structured for a specific dealer-
  positioning thesis; that thesis no longer holds. The P&L is
  immaterial — staying in is hope, not edge.
* **Limit price fallback chain:**
  1. Live dxlink leg mid (preferred, <30s stale during RTH)
  2. `pos.last_mid_per_spread` (broker poll, possibly minutes stale)
  3. Defer the trigger entirely if neither is finite

---

## 7. Failure modes and observability

### 7.1 What can go wrong

| Failure | Detection | Mitigation |
|---|---|---|
| dxlink-worker dies → no live mids | `worker-health` dead-man switch (15-min threshold) | Admin email. trigger-eval P&L rules skip stale quotes; thesis_invalidated still fires. |
| monitor-positions cron skips → stale `last_verdict` | `worker-health` (30-min threshold) | Admin email. thesis_invalidated 30-min staleness guard ignores stale verdict. |
| Tastytrade returns 502 on close-order | trigger row goes `failed` with `execution_result` populated | UI surfaces error inline. User can retry by tapping again (RLS prevents server-side state corruption). |
| Race: user taps Close while a partial fill is happening | `close-order` 409 ("close in flight") | User sees the error; the in-flight close eventually fills, decrements remaining. |
| User cancels mid-partial-fill | NOT handled today | Phase 2 needs `filled-quantity` polling in monitor-positions. |
| Bad limit price → broker rejects | `failed` row, `execution_result.detail` from Tastytrade | Visible in PositionDetail error surface. |
| Verdict false-positive (invalidated → intact within an hour) | Phase-1 logs review | Calibration period before flipping Phase 2 on. |

### 7.2 Audit trail

Every action leaves a row:

* `auto_triggers` — every proposed action, every status transition,
  full audit including `observed` snapshot and `execution_result`.
* `order_history` — every broker call, every status transition, full
  Tastytrade response in `api_response` jsonb.
* `alerts` — every push notification dispatched.
* `health_alerts` — every dead-man-switch tick, with the staleness
  values that tripped it.

Admin-only SELECT policies on all of the above, via `is_admin()`
helper. The owner can query `/admin` to see the timeline.

### 7.3 Observability checklist

For the calibration window before phase 2:

* [ ] How many triggers fire per day? Per kind?
* [ ] How many are dismissed vs executed?
* [ ] Median time from trigger creation to user action?
* [ ] Any `failed` triggers? What broker errors?
* [ ] Any verdict flapping (intact → invalidated → intact within an hour)?
* [ ] Any P&L false-positives from quote staleness slipping past the
  5-min guard?

---

## 8. Phase 2: autonomous execution

**Not currently enabled.** The infrastructure exists but the cron
writes to `auto_triggers` for user approval rather than calling
`close-order` directly.

### 8.1 Required additions

**1. Per-user kill switch.** New column on `profiles`:

```sql
ALTER TABLE profiles
  ADD COLUMN auto_execute_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE profiles
  ADD COLUMN auto_execute_max_per_day int NOT NULL DEFAULT 5;
```

Default `false` — explicit opt-in required, no surprise autonomous
trading. `auto_execute_max_per_day` is a circuit breaker for the
"runaway eval" scenario (e.g. a regression that fires invalidated for
every position simultaneously).

**2. Settings UI.** Toggle + slider for the two profile fields, with
a clear warning band: "Autonomous trades execute without confirmation
during RTH. Daily limit and kill switch in effect."

**3. trigger-eval branch.** When inserting a trigger row, if the user
has `auto_execute_enabled = true` AND today's executed count for the
user < `auto_execute_max_per_day`, invoke close-order directly with
the proposed_action body + a service-role-derived account number
(largest non-paper, same logic as the UI's get-account fetch). Trigger
row goes straight to `executed` (or `failed`); UI banner appears
informationally for ~10 min then auto-dismisses.

**4. Account number resolution server-side.** Today the UI fetches
get-account on mount. The server needs to do the same, then cache the
preferred account_number per user in profiles. New column:

```sql
ALTER TABLE profiles
  ADD COLUMN preferred_account_number text;
```

Populated either by a new `set-preferred-account` edge function the
user calls from Settings, OR by trigger-eval's first autonomous run
(falling back to get-account if null).

**5. Daily-count query.** Cheap:

```sql
SELECT COUNT(*) FROM auto_triggers
WHERE user_id = $1
  AND status = 'executed'
  AND executed_at::date = (now() AT TIME ZONE 'America/New_York')::date;
```

Indexed on `(user_id, status, executed_at)` (add to phase-2 migration).

**6. Push wording change.** When auto-executed, the push should say
"Closed automatically: <reason>" not "Tap to close." User knows it
already happened.

### 8.2 What does NOT change

* `auto_triggers` schema stays the same — autonomous executions still
  write rows, just with `status='executed'` from the start.
* `close-order` stays the same — already supports the trigger_id
  handoff. Service-role-invoked path needs no new auth.
* UI `AutoTriggersCard` stays the same — pending rows still surface
  as banners; executed rows just don't.
* Verdict logic, rule thresholds, sizing math — all unchanged.

### 8.3 Phase 2 prerequisites (gates)

* **At least 2-4 weeks of phase 1 telemetry**, with the checklist in
  §7.3 reviewed. Specifically:
  * Verdict flap rate < 5% (a flap = invalidated → intact in the same
    session).
  * Zero false-positive stop-loss triggers from quote staleness.
  * 100% of executed triggers either fill within 5 min or fail with a
    clear broker reason.
* **Manual signoff.** Cameron flips `auto_execute_enabled=true` on his
  own profile via Settings. No bulk enable.
* **Communication.** If this is ever offered to other users, see §11
  (regulatory) before shipping.

### 8.4 Effort estimate

~3-4 hours, broken down:

| Task | Time |
|---|---|
| Migration (kill switch + preferred account columns + index) | 30 min |
| Settings UI (toggle + slider + warning) | 1 hr |
| trigger-eval autonomous branch + daily-count gate | 1 hr |
| Push-wording change + executed-row UX | 30 min |
| End-to-end test on sandbox | 1 hr |

---

## 9. The "shared module" non-problem

Earlier in this build I assumed verdict porting would be the bottleneck
— ~100 lines of client JS to translate into Deno-compatible TS while
keeping outputs identical. Turned out:

1. `monitor-positions` already runs the verdict server-side every 5 min
   and caches the result on `open_positions.last_verdict`.
2. The client UI reads the same cached value via `pos.last_verdict`
   (yes, the column is what the UI banner displays — not a fresh
   client-side recompute).
3. `trigger-eval` reads the same column.

So there's exactly ONE place the verdict is computed
(`monitor-positions/thesisVerdict.ts`) and TWO consumers (UI + trigger-
eval). The "share the module" question reduces to "make sure
`thesisVerdict.ts` matches the client's `src/utils/thesisVerdict.js`."

Today the two files are in sync line-for-line. The comment header on
each says **"Keep in sync with [other file]."** A regression-fixture
test would mechanically enforce this, but it's not gating. Recommended
for a follow-up PR if the verdict logic starts churning.

---

## 10. Open questions and future work

### 10.1 Deep-link auto-confirm

Today `?trigger=<id>` is informational. A more refined UX would open
the PositionDetail page already focused on the trigger, with the
"Close all" button already touched/highlighted so it's one tap from
notification → action. Worth doing once we have phase-1 logs showing
median time-to-action.

### 10.2 Credit spread P&L

Phase 1 P&L rules skip credit spreads (bull put / bear call) because
`entry_debit_per_spread` has a different sign convention. Three fixes
possible:

* Unify the column (positive = paid debit, negative = received credit).
  Requires backfill + UI changes.
* Add `entry_credit_per_spread` and branch on strategy type in the
  P&L math.
* Compute P&L from the raw legs without using `entry_debit_per_spread`
  at all (long leg mid - short leg mid - entry_long_mid + entry_short_mid).

`thesis_invalidated` already fires for credit spreads (it reads
verdict, not P&L), so they have at least one trigger path today.

### 10.3 User-cancels-mid-partial-fill

If a user cancels a partial-filled close order, `contracts_remaining`
won't decrement (monitor-positions only acts on the `filled` terminal
state, not the `cancelled` after a partial). Fix: poll `filled-
quantity` from Tastytrade and reconcile on `cancelled` too.

Not a hot bug — covered by manual outcome logging — but worth
addressing before Phase 2.

### 10.4 EOD expiry of pending triggers

Pending triggers from morning that the user never approved will
linger forever. A cron at 4:01pm ET that sets `status='expired'` for
any pending row >12 hours old would clean this up. The `expired`
state is already in the CHECK constraint, just no writer yet.

### 10.5 Trigger fatigue

If a position oscillates around -50% (drops, recovers, drops, recovers),
each oscillation can create a fresh stop_loss trigger after the user
dismisses the prior one. The unique index only covers `pending`. May
want a "dismissed within last hour → don't re-create" cooldown.

### 10.6 Multi-leg complex strategies

Today's support is for 2-leg verticals only. Iron condors, butterflies,
calendars all need 4-leg order construction. Not in scope for this
spec — would be a separate Phase 3 or 4 build.

---

## 11. Regulatory / legal posture

**Important.** Read before enabling Phase 2 for anyone but the owner.

### 11.1 Your own account

Auto-trading your own money is unambiguously fine. No registration
required. Tastytrade's API does not restrict algorithmic trading on
personal accounts beyond their standard ToS.

### 11.2 Other users' accounts

When the system places orders without confirmation **on behalf of
another user**, that crosses into territory typically reserved for:

* Registered Investment Advisors (RIAs) — Series 65 individual or
  state RIA firm.
* Robo-advisors — also registered as RIAs with additional algorithmic
  disclosures.

The cleanest legal posture for a SaaS product is **"signal
subscription, user executes."** Phase 1 (semi-auto with one-tap
approval) sits squarely on that side. Phase 2 (autonomous) starts to
look like managed money.

If you ever offer Phase 2 to other users:

1. Talk to a securities lawyer first. Not "Google it" — actually pay
   for an hour of advice. RIA registration is non-trivial but
   tractable; doing it wrong is expensive.
2. Terms of Service must include explicit consent to autonomous
   execution, plus a clear daily limit, plus an obvious kill switch
   reachable without the app (email-based dead-man).
3. Strongly consider keeping it owner-only forever. The product is
   defensible as "I built a tool for my own trading and you can use
   it as a signal subscription"; it becomes a much harder sell
   commercially the moment it's "I trade your account."

### 11.3 Disclosures (Phase 1)

Even semi-auto needs:

* A persistent "Past performance does not guarantee future results"
  disclosure on the public track record.
* A clear note that triggers are heuristic, not a guarantee.
* A clear note that the user is responsible for every trade they
  approve.

The current public-record page already has the immutability proof
layer; the disclosure copy is a small content addition.

---

## 12. Files in this system

| Path | Role |
|---|---|
| `supabase/migrations/20260511000003_auto_triggers.sql` | `auto_triggers` table |
| `supabase/migrations/20260511000004_order_history_position_id.sql` | `order_history.position_id` |
| `supabase/migrations/20260511000005_contracts_remaining.sql` | Partial-close support + auto-close DB trigger |
| `supabase/functions/trigger-eval/index.ts` | The rule-evaluation cron handler |
| `supabase/functions/close-order/index.ts` | Closing-order submission |
| `supabase/functions/close-order/tastytrade.ts` | OAuth + OCC builder (copied from place-order) |
| `supabase/functions/monitor-positions/index.ts` | Verdict cache + fill reconciliation |
| `supabase/functions/monitor-positions/thesisVerdict.ts` | Server-side verdict (sync'd with client) |
| `supabase/functions/worker-health/index.ts` | Dead-man switch (adjacent system) |
| `.github/workflows/trigger-eval.yml` | 5-min RTH cron |
| `.github/workflows/monitor-positions.yml` | 5-min RTH cron (existing) |
| `src/utils/thesisVerdict.js` | Client-side verdict (sync'd with server) |
| `src/pages/PositionDetail.jsx` → `AutoTriggersCard` | The user-facing banner |

---

## 13. Glossary

| Term | Meaning in this system |
|---|---|
| **Trigger** | A row in `auto_triggers`. Represents a rule that has tripped and an action being proposed. |
| **Kind** | The categorical reason: `stop_loss_50`, `profit_take_100`, `profit_take_200`, `thesis_invalidated`. |
| **Status** | The trigger's lifecycle state: pending / approved / executed / failed / dismissed / expired. |
| **Verdict** | The cached state of "is this trade's thesis still alive": `intact` / `drifting` / `invalidated` / `not_evaluable`. Computed by monitor-positions, read by both the UI and trigger-eval. |
| **Scale out** | Partial close. Profit takes propose scale-outs (50% / 75% of remainder); stop loss and thesis_invalidated propose full close. |
| **Remaining** | `open_positions.contracts_remaining` — the live contract count after any partial closes. Decremented by `monitor-positions` on broker fills. |
| **Eval** | The trigger-eval cron tick. One eval = scan all open positions, fire any triggers that aren't already pending. |
| **Idempotency** | The partial unique index on `(position_id, kind) WHERE status='pending'` that prevents duplicate pending triggers per kind per position. |

---

*Last updated: 2026-05-11*
*Owner: Cameron Wiley (cameron@cashmoves.io)*
*Companion docs: `CLAUDE.md`, `RISK_MANAGEMENT.md`*
