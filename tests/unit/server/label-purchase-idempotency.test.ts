import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  buildIdempotencyKey,
  computeRateSignature,
  IdempotencyPriorFailureError,
  purchaseLabelIdempotent,
} from "@/lib/server/label-purchase-idempotency";

// ── In-memory mock of label_purchase_attempts ────────────────────────────────
// Keyed by (workspace_id, idempotency_key). Mimics Postgres UNIQUE behavior.

interface AttemptRow {
  id: string;
  workspace_id: string;
  order_external_id: string;
  order_source: string;
  shipment_id: string | null;
  idempotency_key: string;
  rate_signature: string;
  succeeded: boolean;
  response_json: unknown;
  tracking_number: string | null;
  error_text: string | null;
  attempt_finished_at: string | null;
}

function makeMockSupabase(): {
  supabase: SupabaseClient;
  rows: AttemptRow[];
  counters: { insertAttempts: number; selectAttempts: number; updateAttempts: number };
} {
  const rows: AttemptRow[] = [];
  let idSeq = 1;

  // Tracking shape: tests assert on these counters
  const counters = {
    insertAttempts: 0,
    selectAttempts: 0,
    updateAttempts: 0,
  };

  const supabase = {
    from(_table: string) {
      let _select: string | null = null;
      const _eqs: Array<[string, unknown]> = [];
      let _insertPayload: Partial<AttemptRow> | null = null;
      let _updatePayload: Partial<AttemptRow> | null = null;

      const builder = {
        select(s: string) {
          _select = s;
          return builder;
        },
        insert(payload: Partial<AttemptRow>) {
          _insertPayload = payload;
          counters.insertAttempts++;
          return builder;
        },
        update(payload: Partial<AttemptRow>) {
          _updatePayload = payload;
          counters.updateAttempts++;
          return builder;
        },
        eq(col: string, val: unknown) {
          _eqs.push([col, val]);
          return builder;
        },
        async maybeSingle() {
          counters.selectAttempts++;
          const match = rows.find((r) =>
            _eqs.every(([col, val]) => r[col as keyof AttemptRow] === val),
          );
          return { data: match ?? null, error: null };
        },
        async single() {
          // Insert path
          if (_insertPayload) {
            const conflict = rows.find(
              (r) =>
                r.workspace_id === _insertPayload?.workspace_id &&
                r.idempotency_key === _insertPayload?.idempotency_key,
            );
            if (conflict) {
              return { data: null, error: { message: "duplicate key" } };
            }
            const row: AttemptRow = {
              id: `att_${idSeq++}`,
              workspace_id: String(_insertPayload.workspace_id ?? ""),
              order_external_id: String(_insertPayload.order_external_id ?? ""),
              order_source: String(_insertPayload.order_source ?? ""),
              shipment_id: (_insertPayload.shipment_id as string | null) ?? null,
              idempotency_key: String(_insertPayload.idempotency_key ?? ""),
              rate_signature: String(_insertPayload.rate_signature ?? ""),
              succeeded: false,
              response_json: null,
              tracking_number: null,
              error_text: null,
              attempt_finished_at: null,
            };
            rows.push(row);
            return { data: { id: row.id }, error: null };
          }
          return { data: null, error: { message: "no insert payload" } };
        },
        // .update().eq() returns thenable that resolves on await
        then(onFulfilled: (v: { data: null; error: null }) => unknown) {
          if (_updatePayload && _eqs.length > 0) {
            const idEq = _eqs.find((e) => e[0] === "id");
            if (idEq) {
              const row = rows.find((r) => r.id === idEq[1]);
              if (row) Object.assign(row, _updatePayload);
            }
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };

  return { supabase: supabase as unknown as SupabaseClient, rows, counters };
}

const baseArgs = {
  workspaceId: "ws_1",
  orderExternalId: "order_42",
  orderSource: "shipstation" as const,
  rate: {
    carrier: "USPS",
    service: "Priority",
    rate: 12.34,
    currency: "USD",
    carrierAccountId: null,
  },
  easypostShipmentId: "shp_aaa",
};

describe("computeRateSignature", () => {
  it("produces the same signature for case-different carriers", () => {
    const a = computeRateSignature({ carrier: "USPS", service: "Priority", rate: 12.34 });
    const b = computeRateSignature({ carrier: "usps", service: "Priority", rate: 12.34 });
    expect(a).toBe(b);
  });

  it("produces the same signature for $12.34 and '12.34'", () => {
    const a = computeRateSignature({ carrier: "USPS", service: "Priority", rate: 12.34 });
    const b = computeRateSignature({ carrier: "USPS", service: "Priority", rate: "12.34" });
    expect(a).toBe(b);
  });

  it("differs when carrier_account_id changes (same rate, different account)", () => {
    const a = computeRateSignature({
      carrier: "Asendia",
      service: "PMI",
      rate: 14,
      carrierAccountId: "ca_aaa",
    });
    const b = computeRateSignature({
      carrier: "Asendia",
      service: "PMI",
      rate: 14,
      carrierAccountId: "ca_bbb",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildIdempotencyKey", () => {
  it("contains workspace, order, and rate_signature segments", () => {
    const key = buildIdempotencyKey({
      workspaceId: "ws_1",
      orderExternalId: "order_42",
      rateSignature: "deadbeef",
    });
    expect(key).toBe("easypost-buy:ws_1:order_42:deadbeef");
  });
});

describe("purchaseLabelIdempotent (Phase 0.3 outbox)", () => {
  it("calls buyFn exactly once on first attempt and returns bought=true", async () => {
    const { supabase } = makeMockSupabase();
    const buy = vi.fn().mockResolvedValue({ id: "shp_aaa", tracking_code: "TRK1" });

    const result = await purchaseLabelIdempotent(supabase, baseArgs, buy);

    expect(result.bought).toBe(true);
    expect(result.response).toEqual({ id: "shp_aaa", tracking_code: "TRK1" });
    expect(buy).toHaveBeenCalledTimes(1);
  });

  it("Trigger.dev retry scenario: second invocation returns cached response and does NOT call buyFn again", async () => {
    const { supabase } = makeMockSupabase();
    const buy = vi.fn().mockResolvedValue({ id: "shp_aaa", tracking_code: "TRK1" });

    const first = await purchaseLabelIdempotent(supabase, baseArgs, buy);
    expect(first.bought).toBe(true);

    // Simulate a second attempt (e.g., Trigger.dev retried after a transient
    // failure between the EP buy and the DB stamp). The wrapper MUST short-
    // circuit and return the cached response without re-calling EP.
    const secondBuy = vi.fn().mockResolvedValue({ id: "shp_DUP", tracking_code: "TRK_DUP" });
    const second = await purchaseLabelIdempotent(supabase, baseArgs, secondBuy);

    expect(second.bought).toBe(false);
    expect(second.response).toEqual({ id: "shp_aaa", tracking_code: "TRK1" });
    expect(secondBuy).not.toHaveBeenCalled();
    expect(buy).toHaveBeenCalledTimes(1);
  });

  it("partial-failure scenario (J.6 scenario E): buyFn throws → row stamped as failed and second attempt surfaces prior failure", async () => {
    const { supabase } = makeMockSupabase();
    const buy = vi.fn().mockRejectedValue(new Error("EasyPost connection reset"));

    await expect(purchaseLabelIdempotent(supabase, baseArgs, buy)).rejects.toThrow(
      /EasyPost connection reset/,
    );
    expect(buy).toHaveBeenCalledTimes(1);

    // Second attempt sees the failed row and refuses to re-call EP automatically.
    const secondBuy = vi.fn();
    await expect(purchaseLabelIdempotent(supabase, baseArgs, secondBuy)).rejects.toThrow(
      IdempotencyPriorFailureError,
    );
    expect(secondBuy).not.toHaveBeenCalled();
  });

  it("different rate_signature → different key → buyFn DOES fire (rate change is a new attempt)", async () => {
    const { supabase } = makeMockSupabase();
    const buy = vi.fn().mockResolvedValue({ id: "shp_a", tracking_code: "T1" });

    await purchaseLabelIdempotent(supabase, baseArgs, buy);

    // Same order, different rate (e.g., staff picked Asendia instead of USPS)
    const buy2 = vi.fn().mockResolvedValue({ id: "shp_b", tracking_code: "T2" });
    const result = await purchaseLabelIdempotent(
      supabase,
      {
        ...baseArgs,
        rate: { ...baseArgs.rate, carrier: "Asendia", service: "PMI", rate: 14 },
      },
      buy2,
    );
    expect(result.bought).toBe(true);
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy2).toHaveBeenCalledTimes(1);
  });
});
