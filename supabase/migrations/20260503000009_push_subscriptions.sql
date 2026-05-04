-- Pharma Edge — server-side web-push delivery infrastructure.
--
-- Each row is one PushSubscription (browser/device pair) attached to a
-- user. The frontend subscribes via pushManager and writes the row
-- directly using the user's JWT (RLS enforces ownership). The
-- send-alerts edge function reads the rows for a target user and
-- fan-outs the encrypted push notifications using VAPID keys held in
-- Supabase secrets (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).
--
-- endpoint is UNIQUE so the same browser re-subscribing replaces the
-- prior row via UPSERT instead of accumulating duplicates.

CREATE TABLE push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX push_subscriptions_user_idx
  ON push_subscriptions (user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Per-action policies, cached auth.uid() form. Service role bypasses
-- and is what the send-alerts edge function uses to fan out.
CREATE POLICY push_subscriptions_select_own ON push_subscriptions
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

CREATE POLICY push_subscriptions_insert_own ON push_subscriptions
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY push_subscriptions_update_own ON push_subscriptions
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY push_subscriptions_delete_own ON push_subscriptions
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);
