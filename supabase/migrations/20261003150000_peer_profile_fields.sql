-- Peer comparison (owner, 2026-10-03): net worth vs the Federal Reserve's
-- Survey of Consumer Finances by age, household, homeownership, income and —
-- only when the user chooses to share them — education, race / ethnicity
-- and (single households only) sex.
--
-- Kept on leaps_tax_profiles, whose RLS is own-row only (no anon policy),
-- not on profiles (which has public / anon read policies). All optional;
-- NULL = not shared. Categories match the SCF's own classes.

ALTER TABLE public.leaps_tax_profiles ADD COLUMN IF NOT EXISTS birth_date date
  CHECK (birth_date IS NULL OR (birth_date >= DATE '1900-01-01' AND birth_date <= CURRENT_DATE));
ALTER TABLE public.leaps_tax_profiles ADD COLUMN IF NOT EXISTS sex text
  CHECK (sex IS NULL OR sex IN ('female', 'male'));
ALTER TABLE public.leaps_tax_profiles ADD COLUMN IF NOT EXISTS race_ethnicity text
  CHECK (race_ethnicity IS NULL OR race_ethnicity IN ('white', 'black', 'hispanic', 'other'));
ALTER TABLE public.leaps_tax_profiles ADD COLUMN IF NOT EXISTS education text
  CHECK (education IS NULL OR education IN ('no_hs', 'hs', 'some_college', 'bachelors'));

COMMENT ON COLUMN public.leaps_tax_profiles.birth_date IS 'For the peer comparison (age band). Own-row RLS only.';
COMMENT ON COLUMN public.leaps_tax_profiles.sex IS 'Optional; used only for single households in the peer comparison.';
COMMENT ON COLUMN public.leaps_tax_profiles.race_ethnicity IS 'Optional; SCF RACECL4 classes. Peer comparison only.';
COMMENT ON COLUMN public.leaps_tax_profiles.education IS 'Optional; SCF EDCL classes. Peer comparison only.';
