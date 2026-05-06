-- profiles.subscription_tier — gating column for the Free / Pro split.
--
-- 'free' is the default for every new signup; 'pro' unlocks the full
-- scanner queue, full /markets ticker list, full Claude analysis quota,
-- and broker execution. Stripe wire-up will write to this column when
-- a checkout completes; for now Cameron's account is hardcoded to 'pro'
-- so he can use the app unrestricted while building.
--
-- We deliberately don't add an UPDATE policy here — clients can't write
-- this column. Service role (Stripe webhook in the future) is the only
-- writer.

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'free'
        CHECK (subscription_tier IN ('free', 'pro'));

-- Promote the owner account so the build experience isn't gated.
-- Idempotent: if the email isn't found yet (first-time signup later),
-- the UPDATE is a no-op and a follow-up run lands the row.
UPDATE public.profiles
SET subscription_tier = 'pro'
WHERE id IN (
    SELECT id FROM auth.users WHERE email = 'pharmaedge007@gmail.com'
);
