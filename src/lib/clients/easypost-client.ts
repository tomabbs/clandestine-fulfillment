/**
 * EasyPost API client.
 *
 * Features:
 * - Rate selection with Media Mail eligibility (mediaMailEligible — NOTE: NOT mediaMallEligible)
 * - Normalized service mapping (stable across API response variations)
 * - SCAN Form generation via Batch API
 * - Address verification
 *
 * Rule #5: Zod validation on external API responses.
 */

import EasyPostClient from "@easypost/api";
import { z } from "zod";
import { env } from "@/lib/shared/env";
import { getServiceDetails, normalizeService } from "./easypost-service-map";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DOMESTIC_COUNTRY_CODES = ["US", "PR", "VI", "GU", "AS", "MP"] as const;

export function isDomesticShipment(countryCode: string): boolean {
  return (DOMESTIC_COUNTRY_CODES as readonly string[]).includes(countryCode.toUpperCase());
}

export const WAREHOUSE_ADDRESS = {
  name: "Danny Berg",
  company: "Clandestine Distribution",
  street1: "2701 Spring Grove Ave",
  street2: "Suite 403",
  city: "Cincinnati",
  state: "OH",
  zip: "45225",
  country: "US",
  phone: "",
} as const;

// ── Zod schemas ───────────────────────────────────────────────────────────────

const rateSchema = z.object({
  id: z.string(),
  carrier: z.string(),
  service: z.string(),
  rate: z.string(),
  delivery_days: z.number().nullish(),
  delivery_date: z.string().nullish(),
});

const shipmentSchema = z.object({
  id: z.string(),
  tracking_code: z.string().nullish(),
  rates: z.array(rateSchema).default([]),
  selected_rate: rateSchema.nullish(),
  postage_label: z
    .object({
      label_url: z.string(),
      label_pdf_url: z.string().nullish(),
    })
    .nullish(),
  messages: z
    .array(
      z.object({
        carrier: z.string().optional(),
        type: z.string().optional(),
        message: z.string(),
      }),
    )
    .optional(),
});

const scanFormSchema = z.object({
  id: z.string(),
  form_url: z.string(),
  tracking_codes: z.array(z.string()).default([]),
});

const batchSchema = z.object({
  id: z.string(),
  state: z.string(),
  num_shipments: z.number(),
  scan_form: scanFormSchema.nullish(),
});

export type EasyPostRate = z.infer<typeof rateSchema>;
export type EasyPostShipment = z.infer<typeof shipmentSchema>;
export type EasyPostBatch = z.infer<typeof batchSchema>;

// ── Client singleton ──────────────────────────────────────────────────────────

let _client: InstanceType<typeof EasyPostClient> | null = null;

function getClient(): InstanceType<typeof EasyPostClient> {
  if (!_client) {
    _client = new EasyPostClient(env().EASYPOST_API_KEY);
  }
  return _client;
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateShipmentInput {
  fromAddress: {
    name: string;
    company?: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
  };
  toAddress: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
  };
  parcel: {
    weight: number; // oz
    length?: number; // inches
    width?: number;
    height?: number;
  };
  /**
   * Phase 0.5.4 — pre-built customs items from line items. Use buildCustomsItems()
   * from customs-builder.ts. When omitted, falls back to the legacy single-item
   * "Vinyl Records / $25 / hs 8523.80" placeholder for back-compat.
   */
  customsItems?: Array<{
    description: string;
    quantity: number;
    weight: number; // oz, per-line
    value: number; // USD, per-line line total (qty × unit price)
    hsTariffNumber: string;
    originCountry?: string;
  }>;
  /** Legacy single-item shape — superseded by customsItems. */
  customsInfo?: {
    contentsType: string;
    hsCode: string;
    description: string;
    value: number;
  };
  /** When true, requests USPS Media Mail rates via special_rates_eligibility. */
  mediaMailEligible?: boolean;
}

// ── API methods ───────────────────────────────────────────────────────────────

// Asendia/USA Export carrier account ID — requires explicit inclusion in
// international shipment requests (not included in EasyPost default rate shopping).
// Also requires parcel dimensions (not just weight) to return rates.
//
// Phase 0.5.3: pulled from env (EASYPOST_ASENDIA_CARRIER_ACCOUNT_ID) so prod
// vs sandbox can use different accounts without code changes. The env schema
// defaults to the historical prod value so this rollout is non-breaking.
//
// Lazy getter so module import never throws when env hasn't been parsed yet
// (e.g., in test files that don't set EASYPOST_ASENDIA_CARRIER_ACCOUNT_ID).
const ASENDIA_DEFAULT = "ca_0f7e073887204bd491a6230936baf754";
let _asendiaCarrierAccountId: string | null = null;
export function getAsendiaCarrierAccountId(): string {
  if (_asendiaCarrierAccountId == null) {
    try {
      _asendiaCarrierAccountId =
        env().EASYPOST_ASENDIA_CARRIER_ACCOUNT_ID || ASENDIA_DEFAULT;
    } catch {
      // env() may throw if other required vars aren't set (e.g., test envs).
      // Fall back to the historical hardcoded value so the module stays usable.
      _asendiaCarrierAccountId = ASENDIA_DEFAULT;
    }
  }
  return _asendiaCarrierAccountId;
}

/**
 * @deprecated Phase 0.5.3 — use `getAsendiaCarrierAccountId()` instead so the
 * value comes from env. Kept as a const for back-compat callers; resolves
 * eagerly at module init using the same fallback path.
 */
export const ASENDIA_CARRIER_ACCOUNT_ID = (() => {
  try {
    return env().EASYPOST_ASENDIA_CARRIER_ACCOUNT_ID || ASENDIA_DEFAULT;
  } catch {
    return ASENDIA_DEFAULT;
  }
})();

// Default parcel dimensions for music packages.
// Asendia requires all three dimensions; these work for standard LP mailers.
const DEFAULT_PARCEL_DIMENSIONS = { length: 13, width: 13, height: 2 };

export async function createShipment(
  input: CreateShipmentInput,
  carrierAccountIds?: string[],
): Promise<EasyPostShipment> {
  const api = getClient();

  // Always include dimensions — Asendia requires them, and they improve rate accuracy.
  const parcel = {
    weight: input.parcel.weight,
    length: input.parcel.length ?? DEFAULT_PARCEL_DIMENSIONS.length,
    width: input.parcel.width ?? DEFAULT_PARCEL_DIMENSIONS.width,
    height: input.parcel.height ?? DEFAULT_PARCEL_DIMENSIONS.height,
  };

  const params: Record<string, unknown> = {
    from_address: input.fromAddress,
    to_address: input.toAddress,
    parcel,
  };

  if (carrierAccountIds?.length) {
    params.carrier_accounts = carrierAccountIds.map((id) => ({ id }));
  }

  // EasyPost does not include Media Mail in the standard rates response.
  // Passing special_rates_eligibility causes USPS to return a MediaMail rate
  // when the shipment is domestic and the parcel is within weight limits.
  if (input.mediaMailEligible) {
    params.options = { special_rates_eligibility: "USPS.MEDIAMAIL" };
  }

  if (!isDomesticShipment(input.toAddress.country)) {
    if (input.customsItems?.length) {
      // Phase 0.5.4 — real per-line customs from order line items.
      params.customs_info = {
        contents_type: input.customsInfo?.contentsType ?? "merchandise",
        customs_items: input.customsItems.map((it) => ({
          description: it.description,
          quantity: it.quantity,
          weight: it.weight,
          value: it.value,
          hs_tariff_number: it.hsTariffNumber,
          origin_country: it.originCountry ?? "US",
        })),
      };
    } else {
      // Legacy fallback — single placeholder item. Logged as a warning so
      // operators can hunt down callers that haven't been migrated to the
      // line-item customs path.
      console.warn(
        "[easypost] International shipment built without per-line customs items — falling back to placeholder. Update caller to pass customsItems[].",
      );
      params.customs_info = {
        contents_type: input.customsInfo?.contentsType ?? "merchandise",
        customs_items: [
          {
            description: input.customsInfo?.description ?? "Vinyl Records",
            quantity: 1,
            weight: parcel.weight,
            value: input.customsInfo?.value ?? 25,
            hs_tariff_number: input.customsInfo?.hsCode ?? "8523.80",
            origin_country: "US",
          },
        ],
      };
    }
  }

  const shipment = await api.Shipment.create(params);
  return shipmentSchema.parse(shipment);
}

/**
 * Select the best available rate based on service priority and Media Mail eligibility.
 *
 * @param rates - Available rates from EasyPost
 * @param mediaMailEligible - True when ALL items in the shipment qualify for Media Mail
 */
export function selectBestRate(
  rates: EasyPostRate[],
  mediaMailEligible: boolean,
): EasyPostRate | null {
  if (!rates.length) return null;

  const normalizedRates = rates.map((rate) => {
    const serviceId = normalizeService(rate.carrier, rate.service);
    const details = getServiceDetails(serviceId);
    return {
      rate,
      serviceId,
      priority: details?.priority ?? 999,
      isMediaMail: details?.isMediaMail ?? false,
    };
  });

  let eligibleRates = normalizedRates;
  if (!mediaMailEligible) {
    eligibleRates = normalizedRates.filter((r) => !r.isMediaMail);
  }

  if (!eligibleRates.length) {
    eligibleRates = normalizedRates;
  }

  const sorted = [...eligibleRates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return parseFloat(a.rate.rate) - parseFloat(b.rate.rate);
  });

  console.log(
    "[easypost] Rate selection:",
    sorted.map((r) => ({ service: r.serviceId, priority: r.priority, price: r.rate.rate })),
  );

  return sorted[0]?.rate ?? null;
}

export async function buyLabel(shipmentId: string, rateId: string): Promise<EasyPostShipment> {
  const api = getClient();
  const purchased = await api.Shipment.buy(shipmentId, rateId);
  return shipmentSchema.parse(purchased);
}

export async function createScanForm(shipmentIds: string[]): Promise<EasyPostBatch> {
  const api = getClient();

  const batch = await api.Batch.create({
    shipments: shipmentIds.map((id) => ({ id })),
  });

  const withScanForm = await api.Batch.createScanForm(batch.id);
  return batchSchema.parse(withScanForm);
}

export async function verifyAddress(
  address: CreateShipmentInput["toAddress"],
): Promise<{ verified: boolean; errors: string[] }> {
  const api = getClient();

  try {
    const result = await api.Address.createAndVerify(address);
    const verifications = (result as unknown as Record<string, unknown>).verifications as
      | Record<string, { success?: boolean; errors?: { message: string }[] }>
      | undefined;
    const delivery = verifications?.delivery;
    return {
      verified: delivery?.success ?? false,
      errors: delivery?.errors?.map((e) => e.message) ?? [],
    };
  } catch (error) {
    return {
      verified: false,
      errors: [error instanceof Error ? error.message : "Address verification failed"],
    };
  }
}
