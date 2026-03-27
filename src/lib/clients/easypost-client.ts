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
  customsInfo?: {
    contentsType: string;
    hsCode: string;
    description: string;
    value: number;
  };
}

// ── API methods ───────────────────────────────────────────────────────────────

export async function createShipment(input: CreateShipmentInput): Promise<EasyPostShipment> {
  const api = getClient();

  const params: Record<string, unknown> = {
    from_address: input.fromAddress,
    to_address: input.toAddress,
    parcel: input.parcel,
  };

  if (!isDomesticShipment(input.toAddress.country)) {
    params.customs_info = {
      contents_type: input.customsInfo?.contentsType ?? "merchandise",
      customs_items: [
        {
          description: input.customsInfo?.description ?? "Vinyl Records",
          quantity: 1,
          weight: input.parcel.weight,
          value: input.customsInfo?.value ?? 25,
          hs_tariff_number: input.customsInfo?.hsCode ?? "8523.80",
          origin_country: "US",
        },
      ],
    };
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
