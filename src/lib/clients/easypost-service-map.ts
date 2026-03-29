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
  // ── USPS Media Mail (priority 1 — cheapest for eligible items) ──────────────
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

  // ── USPS Ground (priority 10) ───────────────────────────────────────────────
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

  // ── UPS ────────────────────────────────────────────────────────────────────
  "ups:ground": {
    carrier: "UPS",
    serviceId: "ups:ground",
    displayName: "UPS Ground",
    priority: 15,
    isMediaMail: false,
  },

  // ── USPS Priority (priority 20) ─────────────────────────────────────────────
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

  // ── Asendia / USA Export (international — preferred over USPS international)
  // EasyPost returns these with carrier "AsendiaPowerofUS", "USAExport", or
  // "Asendia". Priority < USPS international because Asendia is typically cheaper.

  "asendia:epacket": {
    carrier: "Asendia",
    serviceId: "asendia:epacket",
    displayName: "Asendia ePacket",
    priority: 80,
    isMediaMail: false,
  },
  "asendia:economyairmail": {
    carrier: "Asendia",
    serviceId: "asendia:economyairmail",
    displayName: "Asendia Economy Airmail",
    priority: 82,
    isMediaMail: false,
  },
  "asendia:priorityairmail": {
    carrier: "Asendia",
    serviceId: "asendia:priorityairmail",
    displayName: "Asendia Priority Airmail",
    priority: 85,
    isMediaMail: false,
  },
  "asendia:prioritymailinternational": {
    carrier: "Asendia",
    serviceId: "asendia:prioritymailinternational",
    displayName: "Asendia Priority Mail International",
    priority: 88,
    isMediaMail: false,
  },
  "asendia:firstclasspackageinternationalservice": {
    carrier: "Asendia",
    serviceId: "asendia:firstclasspackageinternationalservice",
    displayName: "Asendia First Class Package International",
    priority: 90,
    isMediaMail: false,
  },
  "asendia:prioritymailexpressinternational": {
    carrier: "Asendia",
    serviceId: "asendia:prioritymailexpressinternational",
    displayName: "Asendia Priority Mail Express International",
    priority: 95,
    isMediaMail: false,
  },

  // ── USPS International (priority 100+) — fallback when Asendia not available ─
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
  "usps:expressinternatinal": {
    carrier: "USPS",
    serviceId: "usps:expressinternational",
    displayName: "USPS Priority Mail Express International",
    priority: 120,
    isMediaMail: false,
  },
};

/**
 * Normalize an EasyPost carrier+service combination to our canonical serviceId.
 * EasyPost returns Asendia/USA Export rates with varying carrier names:
 * "AsendiaPowerofUS", "USAExport", "Asendia", etc.
 */
export function normalizeService(carrier: string, service: string): string {
  const key = `${carrier.toLowerCase()}:${service.toLowerCase().replace(/[\s\-_]/g, "")}`;

  if (SERVICE_MAP[key]) return key;

  const lowerService = service.toLowerCase().replace(/[\s\-_]/g, "");
  const lowerCarrier = carrier.toLowerCase().replace(/[\s\-_]/g, "");

  // ── Asendia / USA Export fuzzy matching ────────────────────────────────────
  const isAsendia =
    lowerCarrier.includes("asendia") ||
    lowerCarrier.includes("usaexport") ||
    lowerCarrier.includes("asendiapower");

  if (isAsendia) {
    if (lowerService.includes("epacket")) return "asendia:epacket";
    if (lowerService.includes("economy")) return "asendia:economyairmail";
    if (lowerService.includes("express")) return "asendia:prioritymailexpressinternational";
    if (lowerService.includes("priority") && lowerService.includes("airmail"))
      return "asendia:priorityairmail";
    if (lowerService.includes("priority")) return "asendia:prioritymailinternational";
    if (lowerService.includes("firstclass") || lowerService.includes("first"))
      return "asendia:firstclasspackageinternationalservice";
    // Generic Asendia fallback — still gets "Asendia" display prefix
    return `asendia:${lowerService}`;
  }

  // ── USPS fuzzy matching ────────────────────────────────────────────────────
  if (lowerService.includes("media")) return "usps:mediamail";
  if (lowerService.includes("library")) return "usps:librarymail";
  if (lowerService.includes("ground") && lowerService.includes("advantage"))
    return "usps:groundadvantage";
  if (lowerService.includes("ground") && lowerCarrier === "usps") return "usps:ground";
  if (lowerService.includes("ground") && lowerCarrier === "ups") return "ups:ground";
  if (lowerService.includes("priority") && lowerService.includes("express") && lowerService.includes("international"))
    return "usps:expressinternational";
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
 * Unknown Asendia services get a synthetic display name with the Asendia prefix.
 */
export function getServiceDetails(serviceId: string): NormalizedService | null {
  if (SERVICE_MAP[serviceId]) return SERVICE_MAP[serviceId];

  // Synthetic entry for unknown Asendia services so they still display legibly
  if (serviceId.startsWith("asendia:")) {
    const svc = serviceId.replace("asendia:", "").replace(/([a-z])([A-Z])/g, "$1 $2");
    return {
      carrier: "Asendia",
      serviceId,
      displayName: `Asendia ${svc.charAt(0).toUpperCase() + svc.slice(1)}`,
      priority: 91,
      isMediaMail: false,
    };
  }

  return null;
}
