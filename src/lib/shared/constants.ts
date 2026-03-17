export const STAFF_ROLES = [
  "admin",
  "super_admin",
  "label_staff",
  "label_management",
  "warehouse_manager",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const CLIENT_ROLES = ["client", "client_admin"] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

export type UserRole = StaffRole | ClientRole;
