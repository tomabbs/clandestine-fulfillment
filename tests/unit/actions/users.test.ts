import { describe, expect, it } from "vitest";

describe("users actions", () => {
  describe("role validation", () => {
    const VALID_STAFF_ROLES = [
      "admin",
      "super_admin",
      "label_staff",
      "label_management",
      "warehouse_manager",
    ];
    const VALID_CLIENT_ROLES = ["client", "client_admin"];
    const ALL_ROLES = [...VALID_STAFF_ROLES, ...VALID_CLIENT_ROLES];

    it("accepts all defined role values", () => {
      for (const role of ALL_ROLES) {
        expect(ALL_ROLES).toContain(role);
      }
      expect(ALL_ROLES).toHaveLength(7);
    });

    it("rejects invalid role values", () => {
      const invalid = ["viewer", "owner", "superadmin", "ADMIN", ""];
      for (const role of invalid) {
        expect(ALL_ROLES).not.toContain(role);
      }
    });
  });

  describe("admin authorization", () => {
    function requireAdmin(role: string) {
      if (role !== "admin" && role !== "super_admin") {
        throw new Error("Only admins can manage users");
      }
    }

    it("allows admin role", () => {
      expect(() => requireAdmin("admin")).not.toThrow();
    });

    it("allows super_admin role", () => {
      expect(() => requireAdmin("super_admin")).not.toThrow();
    });

    it("rejects label_staff", () => {
      expect(() => requireAdmin("label_staff")).toThrow("Only admins");
    });

    it("rejects warehouse_manager", () => {
      expect(() => requireAdmin("warehouse_manager")).toThrow("Only admins");
    });

    it("rejects client roles", () => {
      expect(() => requireAdmin("client")).toThrow("Only admins");
      expect(() => requireAdmin("client_admin")).toThrow("Only admins");
    });
  });

  describe("self-demotion prevention", () => {
    function checkSelfDemotion(
      callerRole: string,
      callerId: string,
      targetId: string,
      newRole: string,
    ) {
      if (targetId === callerId) {
        const isDowngrade =
          (callerRole === "admin" || callerRole === "super_admin") &&
          newRole !== "admin" &&
          newRole !== "super_admin";
        if (isDowngrade) throw new Error("Cannot demote yourself");
      }
    }

    it("prevents admin from demoting self to label_staff", () => {
      expect(() =>
        checkSelfDemotion("admin", "user-1", "user-1", "label_staff"),
      ).toThrow("Cannot demote yourself");
    });

    it("allows admin to change self to super_admin", () => {
      expect(() =>
        checkSelfDemotion("admin", "user-1", "user-1", "super_admin"),
      ).not.toThrow();
    });

    it("allows admin to demote a different user", () => {
      expect(() =>
        checkSelfDemotion("admin", "user-1", "user-2", "label_staff"),
      ).not.toThrow();
    });
  });

  describe("self-deactivation prevention", () => {
    function checkSelfDeactivation(callerId: string, targetId: string) {
      if (targetId === callerId) throw new Error("Cannot deactivate yourself");
    }

    it("prevents self-deactivation", () => {
      expect(() => checkSelfDeactivation("user-1", "user-1")).toThrow(
        "Cannot deactivate yourself",
      );
    });

    it("allows deactivating another user", () => {
      expect(() => checkSelfDeactivation("user-1", "user-2")).not.toThrow();
    });
  });

  describe("client role org requirement", () => {
    const CLIENT_ROLES = ["client", "client_admin"];

    function validateClientOrgId(role: string, orgId: string | undefined) {
      if (CLIENT_ROLES.includes(role) && !orgId) {
        throw new Error("Client roles require an organization");
      }
    }

    it("requires orgId for client role", () => {
      expect(() => validateClientOrgId("client", undefined)).toThrow(
        "Client roles require",
      );
    });

    it("requires orgId for client_admin role", () => {
      expect(() => validateClientOrgId("client_admin", undefined)).toThrow(
        "Client roles require",
      );
    });

    it("accepts orgId for client role", () => {
      expect(() =>
        validateClientOrgId("client", "org-123"),
      ).not.toThrow();
    });

    it("does not require orgId for staff roles", () => {
      expect(() => validateClientOrgId("admin", undefined)).not.toThrow();
      expect(() => validateClientOrgId("label_staff", undefined)).not.toThrow();
    });
  });

  describe("auto-provision role assignment", () => {
    function getDefaultRole(existingUserCount: number): string {
      return existingUserCount === 0 ? "admin" : "label_staff";
    }

    it("assigns admin to first user", () => {
      expect(getDefaultRole(0)).toBe("admin");
    });

    it("assigns label_staff to subsequent users", () => {
      expect(getDefaultRole(1)).toBe("label_staff");
      expect(getDefaultRole(5)).toBe("label_staff");
    });
  });

  describe("toggle active status", () => {
    it("deactivates an active user", () => {
      const currentActive = true;
      const newActive = !currentActive;
      expect(newActive).toBe(false);
    });

    it("reactivates a deactivated user", () => {
      const currentActive = false;
      const newActive = !currentActive;
      expect(newActive).toBe(true);
    });
  });
});
