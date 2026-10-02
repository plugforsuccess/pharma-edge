-- LDP onboarding: record that the user accepted the disclosures, and
-- which version they saw, alongside the suitability answers.
-- Written by the ldp-onboarding edge function (service role).

ALTER TABLE public.ldp_risk_profiles
  ADD COLUMN IF NOT EXISTS disclosures_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS disclosures_version     text;

COMMENT ON COLUMN public.ldp_risk_profiles.disclosures_version IS
  'Version id of the onboarding disclosures the user accepted (see LDP_DISCLOSURES_VERSION in the ldp-onboarding edge function and LeapsOnboarding.jsx).';
