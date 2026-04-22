/**
 * Normalize shipping addresses to EasyPost format.
 * Handles Bandcamp ship_to_* fields and generic jsonb address objects.
 *
 * Phase 0.5.7: country code is normalized to ISO 3166-1 alpha-2 here so every
 * downstream consumer (EP rate quoting, customs builder, isDomesticShipment)
 * sees a consistent format regardless of source ("USA" / "United States" /
 * "U.S." all collapse to "US"; "UK" → "GB"; etc.).
 */

import { normalizeCountryCodeWithDefault } from "./country-codes";

export interface NormalizedAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

/** Bandcamp raw order address shape */
interface BandcampAddress {
  ship_to_name?: string;
  ship_to_street?: string;
  ship_to_street_2?: string;
  ship_to_city?: string;
  ship_to_state?: string;
  ship_to_zip?: string;
  ship_to_country?: string;
  ship_to_country_code?: string;
}

/** Generic normalized address shape (used in warehouse_orders.shipping_address) */
interface GenericAddress {
  name?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
  phone?: string;
}

export function normalizeAddress(
  address: BandcampAddress | GenericAddress | Record<string, unknown>,
): NormalizedAddress {
  // Bandcamp format — uses ship_to_* prefix
  if ("ship_to_name" in address || "ship_to_street" in address) {
    const bc = address as BandcampAddress;
    return {
      name: bc.ship_to_name ?? "",
      street1: bc.ship_to_street ?? "",
      street2: bc.ship_to_street_2 ?? undefined,
      city: bc.ship_to_city ?? "",
      state: bc.ship_to_state ?? "",
      zip: bc.ship_to_zip ?? "",
      country: normalizeCountryCodeWithDefault(bc.ship_to_country_code ?? bc.ship_to_country),
    };
  }

  // Generic format (warehouse_orders.shipping_address)
  const gen = address as GenericAddress;
  return {
    name: gen.name ?? "",
    street1: gen.street1 ?? "",
    street2: gen.street2 ?? undefined,
    city: gen.city ?? "",
    state: gen.state ?? "",
    zip: gen.postalCode ?? gen.zip ?? "",
    country: normalizeCountryCodeWithDefault(gen.countryCode ?? gen.country),
    phone: gen.phone,
  };
}
