/**
 * Phase 4c (finish-line plan v4) — Role matrix.
 *
 * `ROLE_MATRIX` is the single source of truth for staff/client role lists
 * per Rule #40 ("Define a single ROLE_MATRIX constant in code"). Existing
 * call sites continue to import `STAFF_ROLES` / `CLIENT_ROLES` directly —
 * those are now aliases for the matrix subsets to preserve back-compat
 * during the codemod cycle. New call sites should reach for `ROLE_MATRIX`
 * to avoid splitting the truth surface.
 */
export const ROLE_MATRIX = {
  staff: ["admin", "super_admin", "label_staff", "label_management", "warehouse_manager"],
  client: ["client", "client_admin"],
} as const;

export const STAFF_ROLES = ROLE_MATRIX.staff;
export type StaffRole = (typeof ROLE_MATRIX.staff)[number];

export const CLIENT_ROLES = ROLE_MATRIX.client;
export type ClientRole = (typeof ROLE_MATRIX.client)[number];

export type UserRole = StaffRole | ClientRole;
