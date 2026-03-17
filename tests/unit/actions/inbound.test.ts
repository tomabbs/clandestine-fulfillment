import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// === Mocks ===

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
  rpc: mockRpc,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(async () => mockSupabaseClient),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: vi.fn(async () => ({ id: "mock-task-run-id" })),
  },
}));

// === Helpers ===

function _mockChainedQuery(data: unknown, count?: number, error?: { message: string } | null) {
  const terminal = {
    data,
    error: error ?? null,
    count: count ?? null,
  };

  const chain: Record<string, unknown> = {};
  for (const method of [
    "select",
    "insert",
    "update",
    "eq",
    "in",
    "gte",
    "lte",
    "order",
    "range",
    "single",
  ]) {
    chain[method] = vi.fn().mockReturnValue({ ...terminal, ...chain });
  }

  // select with count needs to chain further
  chain.select = vi.fn().mockReturnValue({ ...terminal, ...chain });

  mockFrom.mockReturnValue(chain);
  return chain;
}

// === Import after mocks ===

let isValidTransition: (
  from: import("../../../src/lib/shared/types").InboundStatus,
  to: import("../../../src/lib/shared/types").InboundStatus,
) => boolean;

beforeAll(async () => {
  const transitionMod = await import("../../../src/lib/shared/inbound-transitions");
  isValidTransition = transitionMod.isValidTransition;
});

describe("isValidTransition", () => {
  it("allows expected → arrived", () => {
    expect(isValidTransition("expected", "arrived")).toBe(true);
  });

  it("allows expected → issue", () => {
    expect(isValidTransition("expected", "issue")).toBe(true);
  });

  it("allows arrived → checking_in", () => {
    expect(isValidTransition("arrived", "checking_in")).toBe(true);
  });

  it("allows checking_in → checked_in", () => {
    expect(isValidTransition("checking_in", "checked_in")).toBe(true);
  });

  it("allows checking_in → issue", () => {
    expect(isValidTransition("checking_in", "issue")).toBe(true);
  });

  it("allows issue → expected (reset)", () => {
    expect(isValidTransition("issue", "expected")).toBe(true);
  });

  it("allows issue → arrived", () => {
    expect(isValidTransition("issue", "arrived")).toBe(true);
  });

  it("allows issue → checking_in", () => {
    expect(isValidTransition("issue", "checking_in")).toBe(true);
  });

  it("rejects expected → checking_in (must go through arrived)", () => {
    expect(isValidTransition("expected", "checking_in")).toBe(false);
  });

  it("rejects expected → checked_in (must go through full flow)", () => {
    expect(isValidTransition("expected", "checked_in")).toBe(false);
  });

  it("rejects arrived → checked_in (must go through checking_in)", () => {
    expect(isValidTransition("arrived", "checked_in")).toBe(false);
  });

  it("rejects checked_in → anything (terminal state)", () => {
    expect(isValidTransition("checked_in", "expected")).toBe(false);
    expect(isValidTransition("checked_in", "arrived")).toBe(false);
    expect(isValidTransition("checked_in", "checking_in")).toBe(false);
    expect(isValidTransition("checked_in", "issue")).toBe(false);
  });

  it("rejects arrived → expected (no backwards without issue)", () => {
    expect(isValidTransition("arrived", "expected")).toBe(false);
  });
});

describe("check-in validation", () => {
  let completeCheckIn: (id: string) => Promise<{ taskRunId: string }>;
  let checkInItem: (input: {
    itemId: string;
    receivedQty: number;
    conditionNotes?: string;
    locationId?: string;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import("../../../src/actions/inbound");
    completeCheckIn = mod.completeCheckIn;
    checkInItem = mod.checkInItem;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects completing check-in when items are unchecked", async () => {
    // Mock shipment in checking_in status
    const fromChain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "single", "in"]) {
      fromChain[method] = vi.fn().mockReturnValue(fromChain);
    }

    let _callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      _callCount++;
      if (table === "warehouse_inbound_shipments") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { status: "checking_in" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "warehouse_inbound_items") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { id: "item-1", received_quantity: 10 },
                { id: "item-2", received_quantity: null }, // unchecked!
              ],
              error: null,
            }),
          }),
        };
      }
      return fromChain;
    });

    await expect(completeCheckIn("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).rejects.toThrow(
      "1 item(s) have not been checked in",
    );
  });

  it("rejects completing check-in when shipment is not checking_in", async () => {
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { status: "expected" },
            error: null,
          }),
        }),
      }),
    }));

    await expect(completeCheckIn("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).rejects.toThrow(
      "Cannot transition from 'expected' to 'checked_in'",
    );
  });

  it("rejects check-in item when shipment is not checking_in", async () => {
    let _callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      _callCount++;
      if (table === "warehouse_inbound_items") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: "item-1", inbound_shipment_id: "shipment-1" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "warehouse_inbound_shipments") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { status: "expected" },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnValue({}) };
    });

    await expect(
      checkInItem({
        itemId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        receivedQty: 5,
      }),
    ).rejects.toThrow("Cannot check in items when shipment status is 'expected'");
  });

  it("rejects negative received quantity via Zod", async () => {
    await expect(
      checkInItem({
        itemId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        receivedQty: -1,
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid UUID for itemId via Zod", async () => {
    await expect(
      checkInItem({
        itemId: "not-a-uuid",
        receivedQty: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("markArrived", () => {
  let markArrived: (id: string) => Promise<void>;

  beforeAll(async () => {
    const mod = await import("../../../src/actions/inbound");
    markArrived = mod.markArrived;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when shipment is not in expected status", async () => {
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { status: "checked_in" },
            error: null,
          }),
        }),
      }),
    }));

    await expect(markArrived("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).rejects.toThrow(
      "Cannot transition from 'checked_in' to 'arrived'",
    );
  });

  it("rejects invalid UUID", async () => {
    await expect(markArrived("bad-id")).rejects.toThrow();
  });
});

describe("beginCheckIn", () => {
  let beginCheckIn: (id: string) => Promise<void>;

  beforeAll(async () => {
    const mod = await import("../../../src/actions/inbound");
    beginCheckIn = mod.beginCheckIn;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when shipment is not in arrived status", async () => {
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { status: "expected" },
            error: null,
          }),
        }),
      }),
    }));

    await expect(beginCheckIn("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).rejects.toThrow(
      "Cannot transition from 'expected' to 'checking_in'",
    );
  });
});
