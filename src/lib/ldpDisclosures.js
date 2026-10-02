// LEAPS bot disclosures, shown at onboarding and when risk answers are
// edited in Settings. The version must match LDP_DISCLOSURES_VERSION in
// supabase/functions/ldp-onboarding/index.ts — bump both whenever this
// text changes so users re-accept.
export const LDP_DISCLOSURES_VERSION = 'ldp-2026-10-02'

export const DISCLOSURES = [
  {
    id: 'loss',
    text: 'LEAPS are options. I can lose the entire premium I pay on any position, and small-cap satellites can move sharply in either direction.',
  },
  {
    id: 'tax',
    text: 'Tax figures shown are estimates. Actual taxes depend on my full tax situation, and I should consult a tax professional.',
  },
  {
    id: 'accuracy',
    text: 'My answers decide what the bot is allowed to buy. They are accurate, and I can update them any time.',
  },
]

// Risk-question options, shared by onboarding and Settings.
export const TOLERANCES = [
  { value: 'conservative', label: 'Conservative', body: 'Protect what I have. Steady, diversified exposure only.' },
  { value: 'moderate', label: 'Moderate', body: 'Some swings are fine for better long-run growth.' },
  { value: 'aggressive', label: 'Aggressive', body: 'I accept large drawdowns, including on small-cap names, for higher upside.' },
]

export const EXPERIENCE = [
  { value: 'none', label: 'None', body: "I haven't traded options before." },
  { value: 'some', label: 'Some', body: "I've placed a few options trades." },
  { value: 'experienced', label: 'Experienced', body: 'I trade options regularly and understand the Greeks.' },
]
