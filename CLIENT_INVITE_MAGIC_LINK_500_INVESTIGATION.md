# Client Invite 500 Investigation Report

## Scope

Investigate why inviting a client portal user from `Admin -> Clients -> [Client] -> Settings -> Client Portal Users` fails with:

- UI error: `An error occurred in the Server Components render...`
- Network error: `POST /admin/clients/{orgId} -> 500`

Expected behavior: send Supabase magic-link/invite email and create a `users` row linked to `org_id`.

---

## Executive Findings

1. The invite server action is throwing, which Next.js surfaces as a generic Server Components error in production.
2. The current live auth backend is returning `email rate limit exceeded` for `auth.admin.inviteUserByEmail(...)`.
3. The action path treats rate-limit as a fallback path intended for "already registered" users, but if the email is new it still throws.
4. That throw produces the observed 500 at `/admin/clients/{id}` and the generic digest message in UI.
5. Core auth/env wiring and DB insertion are functional (validated with direct API tests); primary immediate fault is invite-email rate limiting + action error handling behavior.

---

## Reproduction Path

UI code path:

- `src/app/admin/clients/[id]/page.tsx`
  - `ClientUsersCard` calls `inviteUser(...)` from `src/actions/users.ts`
  - Mutation errors are displayed, but server-action throws still surface as generic production message when not safely returned

Server path:

- `src/actions/users.ts` -> `inviteUser(input)`
  - `requireAuth()` in `src/lib/server/auth-context.ts`
  - `createServiceRoleClient()` in `src/lib/server/supabase-server.ts`
  - `serviceClient.auth.admin.inviteUserByEmail(...)`
  - insert row into `users` table

Observed runtime symptom:

- Browser POST to page action endpoint (`/admin/clients/{id}`) returns 500
- Console shows repeated failed resource loads + generic RSC error

---

## API/Auth Test Evidence

All tests run against local production-style env values (`.env.production`) and Supabase admin endpoints.

### Test 1: Environment + admin API reachability

Result:

- `NEXT_PUBLIC_SUPABASE_URL`: present
- `SUPABASE_SERVICE_ROLE_KEY`: present
- `NEXT_PUBLIC_APP_URL`: present, valid protocol
- `auth.admin.listUsers`: success
- `auth.admin.generateLink(type=invite, redirectTo=/auth/callback)`: success

Conclusion: service-role auth, redirect URL format, and Supabase admin connectivity are healthy.

### Test 2: Simulated DB insert path for client invite

Simulated:

- Generated auth user identity via `auth.admin.generateLink(type=invite)`
- Inserted `users` row with `role='client_admin'`, valid `workspace_id`, valid `org_id`
- Deleted test row for cleanup

Result:

- Insert succeeded
- Cleanup succeeded

Conclusion: DB-side insert constraints for client invite linkage are not the primary blocker.

### Test 3: Direct `inviteUserByEmail` probe

Result:

- `auth.admin.inviteUserByEmail(...)` returned: `email rate limit exceeded`

Conclusion: this is a concrete failing condition that matches the user-facing 500 behavior.

---

## Root Cause Analysis

Primary cause:

- Supabase invite endpoint is rate-limited for outbound invite emails.

Contributing cause in app logic:

- `src/actions/users.ts` currently handles rate-limit together with "already registered" by trying to find an existing auth user.
- For a truly new email under rate limit, lookup fails, then action throws (`Failed to send invite: ...`).
- In production server actions, this appears to client as generic "Server Components render" 500.

Why this matches your screenshot:

- Repeated click attempts trigger repeated POST 500s.
- Each call can continue hitting the same rate-limit window.
- UI receives opaque server-action failure payload, not a user-friendly domain-specific error.

---

## File-Level Findings (Surrounding Files)

- `src/app/admin/clients/[id]/page.tsx`
  - Invite UI is in `ClientUsersCard`
  - Calls `inviteUser` with `{ email, name, role, orgId }`
  - Displays mutation error text if available

- `src/actions/users.ts`
  - Contains server action `inviteUser`
  - Uses `auth.admin.inviteUserByEmail`
  - Rate-limit fallback currently not robust for "new email + rate limit" scenario
  - Throws error which bubbles to page action 500

- `src/lib/server/auth-context.ts`
  - Enforces auth and admin role gates
  - Auto-provisions users rows for authenticated sessions
  - Not the direct failure point in this incident

- `src/lib/server/supabase-server.ts`
  - Creates service-role Supabase client used by invite action
  - Service-role client creation is healthy in diagnostics

- `src/lib/shared/env.ts`
  - Enforces required env vars
  - Env validation itself is not failing in tested environment

- `src/app/(auth)/auth/callback/route.ts`
  - Handles auth code exchange + user provisioning + role-based redirect
  - Relevant downstream to invite acceptance flow

- `docs/DEPLOYMENT.md`
  - Notes required Supabase auth config and callback redirect URL
  - Useful for verifying auth settings and allowlisted redirects

---

## Risk Assessment

- **User impact:** High for client onboarding/admin workflows (invites fail).
- **Data integrity risk:** Low (no partial DB insert observed in tested failure path where invite call fails first).
- **Operational risk:** Medium (rate-limit window can intermittently break admin operations).

---

## Recommended Fix Plan

### Priority 0 (Immediate UX/operational fix)

Update `inviteUser` error strategy to avoid hard-throwing generic 500s for known auth-provider limits:

1. Detect explicit rate-limit errors from `inviteUserByEmail`.
2. Return a structured, user-safe message (for example: "Invite email temporarily rate-limited. Try again in X minutes.") instead of throwing opaque error.
3. Log full provider error server-side for diagnostics.

### Priority 1 (Reliability fix)

Use `auth.admin.generateLink({ type: 'invite' | 'magiclink' })` as fallback for rate-limited cases:

1. Generate invite link without triggering provider email send path.
2. Send link through your own transactional channel (Resend) or queue it for retry.
3. Continue creating `users` row deterministically once auth user id is known.

### Priority 2 (Systemic hardening)

1. Add invite throttling in app layer per admin user/org/email to reduce burst retries.
2. Add server-action error normalization utility for all admin mutations.
3. Add alerting for auth invite failures (count + error class) to Sentry/monitoring.

---

## Suggested Test Matrix After Fix

1. Invite new email (`client_admin`) under normal conditions -> success.
2. Invite existing workspace email -> friendly "already exists" error, no 500.
3. Simulated provider rate-limit -> friendly retry message, no 500.
4. Invite with invalid org id -> validation error, no generic 500.
5. Accept invite link -> `/auth/callback` provisions role and routes to `/portal`.

---

## Practical Next Actions

1. Implement error normalization and rate-limit handling in `src/actions/users.ts`.
2. Add one integration test around invite failure mode (mock auth admin error).
3. Verify production Supabase Auth email rate-limit configuration and provider limits.
4. Optionally implement queued resend fallback for invites.

---

## Bottom Line

The failure is reproducible as an auth-provider email rate-limit condition, and the current server action path turns that condition into a generic 500. The invite system is structurally wired correctly, but it needs explicit handling for rate-limited invite sends to prevent user-facing hard failures.
