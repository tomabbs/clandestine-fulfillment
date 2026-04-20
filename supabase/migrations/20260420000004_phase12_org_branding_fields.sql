-- Phase 12 follow-up — Org branding fields for the unified email pipeline +
-- the public /track/[token] page.
--
-- These were referenced by the Phase 12 send-tracking-email task and the
-- public tracking page, but the columns didn't exist on the organizations
-- table at deploy time. Reads silently fell back to the Clandestine default
-- branding for every org, which is fine for shadow mode but wrong for
-- unified_resend mode where each artist label should look like their own
-- brand.
--
-- All columns nullable; fallback in code is Clandestine defaults when null.

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_color text,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS support_email text,
  ADD COLUMN IF NOT EXISTS brand_website_url text;

COMMENT ON COLUMN organizations.brand_color IS
  'Hex color used in /track/[token] page chrome + Resend email templates. Null → falls back to Clandestine #111827.';
COMMENT ON COLUMN organizations.logo_url IS
  'Public HTTPS URL for the org logo. Used in track page header + email header. Null → falls back to text org name.';
COMMENT ON COLUMN organizations.support_email IS
  'Customer-facing support address. Shown on /track page footer + email footer. Null → support@clandestinedistro.com.';
COMMENT ON COLUMN organizations.brand_website_url IS
  'Optional artist/label website link in /track page footer.';

COMMIT;
