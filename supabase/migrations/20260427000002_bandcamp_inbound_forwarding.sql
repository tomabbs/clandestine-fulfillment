-- Phase 2 §9.3 D2 — per-connection Resend inbound routing.
--
-- Each `bandcamp_connections` row maps to a real Bandcamp band account, but
-- today the resend-inbound router fans every "Bam!"/"Cha-ching!" email out
-- across ALL active bandcamp_connections via a global poll
-- (`bandcamp-sale-poll` schedule task with empty payload). With N active
-- bands, every order email costs N Bandcamp `getMerchDetails()` API calls
-- — at our current scale that's ~80% of cross-tenant API spend on the
-- Bandcamp queue.
--
-- The fix is to route the inbound email to the SPECIFIC connection it
-- belongs to. Bandcamp doesn't tell us in the order email which band the
-- sale was for (the subject is "Bam! Another order for <ARTIST>", not
-- "<BAND_NAME>"), but the operator forwarding setup typically gives each
-- band its own dedicated inbound mailbox (e.g. orders+truepanther@…,
-- orders+americanbubbleboy@…). This migration adds the column the router
-- uses to do that recipient → connection lookup.
--
-- Schema changes:
--   * ADD COLUMN inbound_forwarding_address text  (nullable; populated by
--     operator via the audit script, NOT by this migration — every active
--     row must be filled in before we flip the per-connection routing on).
--   * Partial UNIQUE index on lower(address) WHERE NOT NULL — two
--     connections cannot share an inbound mailbox; deactivated rows can
--     stay NULL without conflict.
--
-- Non-goals:
--   * No backfill. Filling in fake addresses would make the audit script
--     (D5) unable to detect "operator hasn't done the routing setup yet"
--     and the per-connection routing would silently fail to match. We
--     leave NULL → audit script flags it → operator populates → per-
--     connection routing turns on for that row.
--   * No DB-side trigger checking is_active vs address-presence. The
--     router's fallback (band_name match → global poll) keeps the system
--     correct even with NULL addresses; the audit script is the gate.
--
-- Plan reference:
--   docs/.cursor/plans/bandcamp_shopify_enterprise_sync_a448cf6a.plan.md,
--   §9.3 D2 — per-connection inbound forwarding column + audit gate.

ALTER TABLE bandcamp_connections
  ADD COLUMN IF NOT EXISTS inbound_forwarding_address text;

-- Partial unique index: two connections cannot share a mailbox, but
-- multiple deactivated/unconfigured rows can stay NULL together.
-- `lower()` so we never have to think about case-folding at lookup time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bandcamp_connections_inbound_address
  ON bandcamp_connections (lower(inbound_forwarding_address))
  WHERE inbound_forwarding_address IS NOT NULL;

-- Lookup index — hot path is `WHERE lower(inbound_forwarding_address) = $1
-- AND is_active = true` from the resend-inbound router. Plain
-- `lower(...)` btree backs that exact predicate; partial-active variant
-- isn't worth it (the table is small, <100 rows in foreseeable future).
COMMENT ON COLUMN bandcamp_connections.inbound_forwarding_address IS
  'Phase 2 §9.3 D2 — operator-managed mailbox alias used by the resend-inbound router to dispatch order emails to the SPECIFIC bandcamp connection (instead of the global N-way poll). NULL = operator has not configured per-connection routing yet; the router falls back to the global poll for these rows. Populated via scripts/_bandcamp-inbound-forwarding-audit.ts.';

NOTIFY pgrst, 'reload schema';
