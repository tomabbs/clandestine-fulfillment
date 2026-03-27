/**
 * Normalized EasyPost service mapping.
 *
 * Carrier/service names can vary slightly between API responses.
 * This provides a stable mapping for rate selection and Media Mail eligibility.
 *
 * Priority: lower number = more preferred
 */

export interface NormalizedService {
  carrier: string;
  serviceId: string;
  displayName: string;
  priority: number;
  isMediaMail: boolean;
}

// Canonical service definitions
export const SERVICE_MAP: Record<string, NormalizedService> = {
  // USPS Media Mail (priority 1 — cheapest for eligible items)
  "usps:mediamail": {
    carrier: "USPS",
    serviceId: "usps:mediamail",
    displayName: "USPS Media Mail",
    priority: 1,
    isMediaMail: true,
  },
  "usps:librarymail": {
    carrier: "USPS",
    serviceId: "usps:librarymail",
    displayName: "USPS Library Mail",
    priority: 2,
    isMediaMail: true,
  },

  // USPS Ground (priority 10)
  "usps:groundadvantage": {
    carrier: "USPS",
    serviceId: "usps:groundadvantage",
    displayName: "USPS Ground Advantage",
    priority: 10,
    isMediaMail: false,
  },
  "usps:ground": {
    carrier: "USPS",
    serviceId: "usps:ground",
    displayName: "USPS Ground",
    priority: 11,
    isMediaMail: false,
  },

  // USPS Priority (priority 20)
  "usps:priority": {
    carrier: "USPS",
    serviceId: "usps:priority",
    displayName: "USPS Priority Mail",
    priority: 20,
    isMediaMail: false,
  },
  "usps:express": {
    carrier: "USPS",
    serviceId: "usps:express",
    displayName: "USPS Priority Mail Express",
    priority: 30,
    isMediaMail: false,
  },

  // UPS
  "ups:ground": {
    carrier: "UPS",
    serviceId: "ups:ground",
    displayName: "UPS Ground",
    priority: 15,
    isMediaMail: false,
  },

  // International
  "usps:firstclassinternational": {
    carrier: "USPS",
    serviceId: "usps:firstclassinternational",
    displayName: "USPS First Class International",
    priority: 100,
    isMediaMail: false,
  },
  "usps:priorityinternational": {
    carrier: "USPS",
    serviceId: "usps:priorityinternational",
    displayName: "USPS Priority Mail International",
    priority: 110,
    isMediaMail: false,
  },
};

/**
 * Normalize an EasyPost carrier+service combination to our canonical serviceId.
 */
export function normalizeService(carrier: string, service: string): string {
  const key = `${carrier.toLowerCase()}:${service.toLowerCase().replace(/[\s\-_]/g, "")}`;

  if (SERVICE_MAP[key]) return key;

  // Fuzzy fallback for common API response variations
  const lowerService = service.toLowerCase();
  const lowerCarrier = carrier.toLowerCase();

  if (lowerService.includes("media")) return "usps:mediamail";
  if (lowerService.includes("library")) return "usps:librarymail";
  if (lowerService.includes("ground") && lowerService.includes("advantage"))
    return "usps:groundadvantage";
  if (lowerService.includes("ground") && lowerCarrier === "usps") return "usps:ground";
  if (lowerService.includes("ground") && lowerCarrier === "ups") return "ups:ground";
  if (lowerService.includes("priority") && lowerService.includes("express")) return "usps:express";
  if (lowerService.includes("priority") && lowerService.includes("international"))
    return "usps:priorityinternational";
  if (lowerService.includes("priority")) return "usps:priority";
  if (lowerService.includes("first") && lowerService.includes("international"))
    return "usps:firstclassinternational";

  return key;
}

/**
 * Get service details by normalized ID. Returns null for unknown services.
 */
export function getServiceDetails(serviceId: string): NormalizedService | null {
  return SERVICE_MAP[serviceId] ?? null;
}
