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

  // ── USPS Ground Domestic ────────────────────────────────────────────────────
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

  // ── UPS Domestic ───────────────────────────────────────────────────────────
  "ups:ground": {
    carrier: "UPS",
    serviceId: "ups:ground",
    displayName: "UPS Ground",
    priority: 15,
    isMediaMail: false,
  },

  // ── USPS Priority Domestic ──────────────────────────────────────────────────
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

  // ── DHL eCommerce (negotiated USPS international rates — typically cheaper) ─
  // DhlEcsAccount in EasyPost resells USPS international services at lower rates.
  // Carrier in API: "DHLEcs" or "DhlEcs" or "DHLeCS"
  "dhlecs:prioritymailinternational": {
    carrier: "DHL eCommerce",
    serviceId: "dhlecs:prioritymailinternational",
    displayName: "DHL eCommerce Priority Mail International",
    priority: 85,
    isMediaMail: false,
  },
  "dhlecs:firstclasspackageinternationalservice": {
    carrier: "DHL eCommerce",
    serviceId: "dhlecs:firstclasspackageinternationalservice",
    displayName: "DHL eCommerce First Class International",
    priority: 87,
    isMediaMail: false,
  },
  "dhlecs:expressmailinternational": {
    carrier: "DHL eCommerce",
    serviceId: "dhlecs:expressmailinternational",
    displayName: "DHL eCommerce Express Mail International",
    priority: 92,
    isMediaMail: false,
  },

  // ── USA Export - Powered by Asendia (international) ──────────────────────────
  // EasyPost carrier account type: UsaExportPbaAccount
  // Carrier string in API responses: "USAExportPBA" (confirmed via live API test)
  // Requires parcel dimensions + explicit carrier_account_id in shipment creation.
  // Dramatically cheaper than USPS for international: ~$13-16 vs $30+ for UK.
  "usaexportpba:usaexportstandard": {
    carrier: "USAExportPBA",
    serviceId: "usaexportpba:usaexportstandard",
    displayName: "USA Export Standard (Asendia)",
    priority: 78,
    isMediaMail: false,
  },
  "usaexportpba:usaexportplus": {
    carrier: "USAExportPBA",
    serviceId: "usaexportpba:usaexportplus",
    displayName: "USA Export Plus (Asendia)",
    priority: 79,
    isMediaMail: false,
  },
  "usaexportpba:usaexportselect": {
    carrier: "USAExportPBA",
    serviceId: "usaexportpba:usaexportselect",
    displayName: "USA Export Select (Asendia)",
    priority: 93,
    isMediaMail: false,
  },

  // ── USPS International ──────────────────────────────────────────────────────
  "usps:firstclasspackageinternationalservice": {
    carrier: "USPS",
    serviceId: "usps:firstclasspackageinternationalservice",
    displayName: "USPS First Class International",
    priority: 100,
    isMediaMail: false,
  },
  "usps:firstclassinternational": {
    carrier: "USPS",
    serviceId: "usps:firstclassinternational",
    displayName: "USPS First Class International",
    priority: 100,
    isMediaMail: false,
  },
  "usps:prioritymailinternational": {
    carrier: "USPS",
    serviceId: "usps:prioritymailinternational",
    displayName: "USPS Priority Mail International",
    priority: 110,
    isMediaMail: false,
  },
  "usps:priorityinternational": {
    carrier: "USPS",
    serviceId: "usps:priorityinternational",
    displayName: "USPS Priority Mail International",
    priority: 110,
    isMediaMail: false,
  },
  "usps:expressmailinternational": {
    carrier: "USPS",
    serviceId: "usps:expressmailinternational",
    displayName: "USPS Express Mail International",
    priority: 120,
    isMediaMail: false,
  },
  "usps:prioritymailexpressinternational": {
    carrier: "USPS",
    serviceId: "usps:prioritymailexpressinternational",
    displayName: "USPS Priority Mail Express International",
    priority: 120,
    isMediaMail: false,
  },

  // ── DHL Express International ───────────────────────────────────────────────
  "dhlexpress:expressworldwide": {
    carrier: "DHL Express",
    serviceId: "dhlexpress:expressworldwide",
    displayName: "DHL Express Worldwide",
    priority: 95,
    isMediaMail: false,
  },
  "dhlexpress:expressworldwidenondoc": {
    carrier: "DHL Express",
    serviceId: "dhlexpress:expressworldwidenondoc",
    displayName: "DHL Express Worldwide",
    priority: 95,
    isMediaMail: false,
  },
  "dhlexpress:expressenvelope": {
    carrier: "DHL Express",
    serviceId: "dhlexpress:expressenvelope",
    displayName: "DHL Express Envelope",
    priority: 96,
    isMediaMail: false,
  },

  // ── FedEx International ─────────────────────────────────────────────────────
  "fedex:internationalconnectplus": {
    carrier: "FedEx",
    serviceId: "fedex:internationalconnectplus",
    displayName: "FedEx International Connect Plus",
    priority: 97,
    isMediaMail: false,
  },
  "fedex:internationaleconomy": {
    carrier: "FedEx",
    serviceId: "fedex:internationaleconomy",
    displayName: "FedEx International Economy",
    priority: 98,
    isMediaMail: false,
  },
  "fedex:internationalpriorityexpress": {
    carrier: "FedEx",
    serviceId: "fedex:internationalpriorityexpress",
    displayName: "FedEx International Priority Express",
    priority: 105,
    isMediaMail: false,
  },
  "fedex:internationalpriority": {
    carrier: "FedEx",
    serviceId: "fedex:internationalpriority",
    displayName: "FedEx International Priority",
    priority: 106,
    isMediaMail: false,
  },

  // ── Canada Post ─────────────────────────────────────────────────────────────
  "canadapost:priorityworldwide": {
    carrier: "Canada Post",
    serviceId: "canadapost:priorityworldwide",
    displayName: "Canada Post Priority Worldwide",
    priority: 115,
    isMediaMail: false,
  },
  "canadapost:expeditedinternational": {
    carrier: "Canada Post",
    serviceId: "canadapost:expeditedinternational",
    displayName: "Canada Post Expedited International",
    priority: 116,
    isMediaMail: false,
  },
};

/**
 * Normalize an EasyPost carrier+service combination to our canonical serviceId.
 */
export function normalizeService(carrier: string, service: string): string {
  // Strip spaces/hyphens/underscores for key lookup
  const carrierClean = carrier.toLowerCase().replace(/[\s\-_]/g, "");
  const serviceClean = service.toLowerCase().replace(/[\s\-_]/g, "");
  const key = `${carrierClean}:${serviceClean}`;

  if (SERVICE_MAP[key]) return key;

  // ── USA Export / Asendia (UsaExportPbaAccount) ─────────────────────────────
  // Confirmed carrier name from live EasyPost API: "USAExportPBA"
  const isAsendia =
    carrierClean.includes("usaexportpba") ||
    carrierClean.includes("usaexport") ||
    carrierClean.includes("asendia") ||
    carrierClean.includes("asendiapower");

  if (isAsendia) {
    // Map confirmed live service names first
    if (serviceClean.includes("usaexportstandard") || serviceClean === "standard")
      return "usaexportpba:usaexportstandard";
    if (serviceClean.includes("usaexportplus") || serviceClean === "plus")
      return "usaexportpba:usaexportplus";
    if (serviceClean.includes("usaexportselect") || serviceClean === "select")
      return "usaexportpba:usaexportselect";
    // Fallback generic Asendia key — still gets a display name via synthetic entry
    return `usaexportpba:${serviceClean}`;
  }

  // ── DHL eCommerce (DhlEcsAccount — resells USPS at negotiated rates) ────────
  const isDhlEcs =
    carrierClean === "dhlecs" || carrierClean.includes("dhlecs") || carrierClean.includes("dhlecs");

  if (isDhlEcs) {
    if (serviceClean.includes("firstclass") || serviceClean.includes("first"))
      return "dhlecs:firstclasspackageinternationalservice";
    if (serviceClean.includes("express")) return "dhlecs:expressmailinternational";
    if (serviceClean.includes("priority")) return "dhlecs:prioritymailinternational";
    return `dhlecs:${serviceClean}`;
  }

  // ── DHL Express ─────────────────────────────────────────────────────────────
  const isDhlExpress =
    carrierClean === "dhlexpress" ||
    (carrierClean.includes("dhl") && !carrierClean.includes("ecs"));

  if (isDhlExpress) {
    if (serviceClean.includes("envelope")) return "dhlexpress:expressenvelope";
    if (serviceClean.includes("worldwide")) return "dhlexpress:expressworldwide";
    return `dhlexpress:${serviceClean}`;
  }

  // ── FedEx ────────────────────────────────────────────────────────────────────
  const isFedEx = carrierClean.includes("fedex");

  if (isFedEx) {
    if (serviceClean.includes("connectplus") || serviceClean.includes("connect"))
      return "fedex:internationalconnectplus";
    if (serviceClean.includes("priorityexpress")) return "fedex:internationalpriorityexpress";
    if (serviceClean.includes("priority") && serviceClean.includes("international"))
      return "fedex:internationalpriority";
    if (serviceClean.includes("economy") && serviceClean.includes("international"))
      return "fedex:internationaleconomy";
    // Domestic FedEx
    if (serviceClean.includes("ground")) return "ups:ground"; // map to generic ground
    return `fedex:${serviceClean}`;
  }

  // ── Canada Post ──────────────────────────────────────────────────────────────
  if (carrierClean.includes("canadapost") || carrierClean.includes("canada")) {
    if (serviceClean.includes("priority")) return "canadapost:priorityworldwide";
    if (serviceClean.includes("expedited")) return "canadapost:expeditedinternational";
    return `canadapost:${serviceClean}`;
  }

  // ── USPS ─────────────────────────────────────────────────────────────────────
  if (serviceClean.includes("mediamail") || serviceClean.includes("media")) return "usps:mediamail";
  if (serviceClean.includes("librarymail") || serviceClean.includes("library"))
    return "usps:librarymail";
  if (serviceClean.includes("groundadvantage")) return "usps:groundadvantage";
  if (serviceClean.includes("ground") && carrierClean === "usps") return "usps:ground";
  if (serviceClean.includes("expressmailinternational")) return "usps:expressmailinternational";
  if (serviceClean.includes("prioritymailexpressinternational"))
    return "usps:prioritymailexpressinternational";
  if (serviceClean.includes("prioritymailinternational")) return "usps:prioritymailinternational";
  if (
    serviceClean.includes("firstclasspackageinternational") ||
    serviceClean.includes("firstclass")
  )
    return "usps:firstclasspackageinternationalservice";
  if (
    serviceClean.includes("prioritymailexpress") ||
    (serviceClean.includes("priority") && serviceClean.includes("express"))
  )
    return "usps:express";
  if (serviceClean.includes("priority") && serviceClean.includes("international"))
    return "usps:prioritymailinternational";
  if (serviceClean.includes("priority")) return "usps:priority";

  return key;
}

/**
 * Get service details by normalized ID. Returns null for unknown services,
 * with synthetic display names for known carrier prefixes.
 */
export function getServiceDetails(serviceId: string): NormalizedService | null {
  if (SERVICE_MAP[serviceId]) return SERVICE_MAP[serviceId];

  // Synthetic entries for unmapped services — keep them readable
  if (serviceId.startsWith("usaexportpba:")) {
    const svc = serviceId.replace("usaexportpba:", "");
    return {
      carrier: "USAExportPBA",
      serviceId,
      displayName: `USA Export ${svc} (Asendia)`,
      priority: 91,
      isMediaMail: false,
    };
  }
  if (serviceId.startsWith("dhlecs:")) {
    const svc = serviceId.replace("dhlecs:", "");
    return {
      carrier: "DHL eCommerce",
      serviceId,
      displayName: `DHL eCommerce ${svc}`,
      priority: 89,
      isMediaMail: false,
    };
  }
  if (serviceId.startsWith("dhlexpress:")) {
    const svc = serviceId.replace("dhlexpress:", "");
    return {
      carrier: "DHL Express",
      serviceId,
      displayName: `DHL Express ${svc}`,
      priority: 96,
      isMediaMail: false,
    };
  }
  if (serviceId.startsWith("fedex:")) {
    const svc = serviceId.replace("fedex:", "");
    return {
      carrier: "FedEx",
      serviceId,
      displayName: `FedEx ${svc}`,
      priority: 99,
      isMediaMail: false,
    };
  }
  if (serviceId.startsWith("canadapost:")) {
    const svc = serviceId.replace("canadapost:", "");
    return {
      carrier: "Canada Post",
      serviceId,
      displayName: `Canada Post ${svc}`,
      priority: 116,
      isMediaMail: false,
    };
  }

  return null;
}
