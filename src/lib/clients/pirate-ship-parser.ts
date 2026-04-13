import { inflateRawSync } from "node:zlib";
import { z } from "zod";

// --- Minimal XLSX reader (ZIP + XML, no external deps) ---

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  // Find End of Central Directory record (search backwards for signature 0x06054b50)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid ZIP: EOCD not found");

  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  const centralDirEntries = buf.readUInt16LE(eocdOffset + 10);

  let offset = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;

    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    // Read local file header to get actual data
    const localSig = buf.readUInt32LE(localHeaderOffset);
    if (localSig === 0x04034b50) {
      const compressionMethod = buf.readUInt16LE(localHeaderOffset + 8);
      const localCompressedSize = buf.readUInt32LE(localHeaderOffset + 18);
      // When the data descriptor flag (bit 3) is set, local header sizes are 0.
      // Fall back to the central directory sizes which are always correct.
      const cdCompressedSize = buf.readUInt32LE(offset + 20);
      const compressedSize = localCompressedSize || cdCompressedSize;
      const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);

      let data: Buffer;
      if (compressionMethod === 0) {
        data = Buffer.from(raw);
      } else if (compressionMethod === 8) {
        data = inflateRawSync(raw);
      } else {
        data = Buffer.alloc(0);
      }

      entries.push({ name, data });
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siMatches = Array.from(xml.matchAll(/<si>([\s\S]*?)<\/si>/g));
  for (const siMatch of siMatches) {
    const inner = siMatch[1];
    const tMatches = Array.from(inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g));
    let text = "";
    for (const tMatch of tMatches) {
      text += tMatch[1];
    }
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = Array.from(xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g));

  for (const rowMatch of rowMatches) {
    const cells: Map<number, string> = new Map();
    const cellMatches = Array.from(
      rowMatch[1].matchAll(/<c\s+r="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g),
    );

    for (const cellMatch of cellMatches) {
      const colLetters = cellMatch[1];
      const attrs = cellMatch[2];
      const inner = cellMatch[3] ?? "";

      const colIndex = colLettersToIndex(colLetters);
      const isSharedString = /t="s"/.test(attrs);

      const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let value = "";

      if (valueMatch) {
        if (isSharedString) {
          const idx = Number.parseInt(valueMatch[1], 10);
          value = sharedStrings[idx] ?? "";
        } else {
          value = decodeXmlEntities(valueMatch[1]);
        }
      } else {
        // Inline string
        const isMatch = /<is>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/is>/.exec(inner);
        if (isMatch) {
          value = decodeXmlEntities(isMatch[1]);
        }
      }

      cells.set(colIndex, value);
    }

    if (cells.size > 0) {
      const maxCol = Math.max(...Array.from(cells.keys()));
      const row: string[] = [];
      for (let c = 0; c <= maxCol; c++) {
        row.push(cells.get(c) ?? "");
      }
      rows.push(row);
    }
  }

  return rows;
}

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1; // 0-based
}

// --- Pirate Ship XLSX column mapping ---

const PIRATE_SHIP_COLUMNS = {
  orderNumber: ["order number", "order #", "order_number", "order id"],
  trackingNumber: ["tracking number", "tracking #", "tracking_number", "tracking"],
  carrier: ["carrier", "shipping carrier"],
  service: ["service", "shipping service", "service type"],
  shipDate: ["ship date", "date shipped", "shipped date", "date", "created date"],
  weight: ["weight", "weight (oz)", "weight (lbs)", "package weight"],
  cost: ["cost", "shipping cost", "label cost", "total cost", "amount"],
  email: ["email", "recipient email", "customer email"],
  recipientName: [
    "recipient name",
    "recipient",
    "name",
    "ship to name",
    "to name",
    "ship to - name",
  ],
  recipientCompany: ["recipient company", "company", "ship to company", "ship to - company"],
  recipientAddress1: [
    "address",
    "address 1",
    "street",
    "address line 1",
    "ship to - address 1",
    "ship to address",
  ],
  recipientAddress2: ["address 2", "address line 2", "apt", "suite", "ship to - address 2"],
  recipientCity: ["city", "ship to city", "ship to - city"],
  recipientState: ["state", "province", "ship to state", "ship to - state"],
  recipientZip: ["zip", "postal code", "zip code", "ship to zip", "ship to - zip/postal"],
  recipientCountry: ["country", "country code", "ship to country", "ship to - country"],
  // International / customs fields
  customsDescription: [
    "customs description",
    "item description",
    "contents description",
    "customs - description",
  ],
  customsValue: ["customs value", "declared value", "customs - value"],
  customsQuantity: ["customs quantity", "customs qty", "customs - quantity"],
  customsWeight: ["customs weight", "customs - weight"],
  customsHsTariff: [
    "hs tariff",
    "tariff number",
    "hs code",
    "harmonized code",
    "customs - hs tariff",
  ],
  customsCountryOfOrigin: ["country of origin", "origin country", "customs - country of origin"],
} as const;

type ColumnKey = keyof typeof PIRATE_SHIP_COLUMNS;

function buildColumnMap(headerRow: string[]): Map<ColumnKey, number> {
  const map = new Map<ColumnKey, number>();
  const normalizedHeaders = headerRow.map((h) => h.toLowerCase().trim());

  for (const [key, aliases] of Object.entries(PIRATE_SHIP_COLUMNS) as [
    ColumnKey,
    readonly string[],
  ][]) {
    for (const alias of aliases) {
      const idx = normalizedHeaders.indexOf(alias);
      if (idx !== -1) {
        map.set(key, idx);
        break;
      }
    }
  }

  return map;
}

// --- Public types ---

export const parsedShipmentSchema = z.object({
  orderNumber: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  carrier: z.string().nullable(),
  service: z.string().nullable(),
  shipDate: z.string().nullable(),
  weight: z.number().nullable(),
  cost: z.number().nullable(),
  email: z.string().nullable(),
  recipientName: z.string().nullable(),
  recipientCompany: z.string().nullable(),
  recipientAddress1: z.string().nullable(),
  recipientAddress2: z.string().nullable(),
  recipientCity: z.string().nullable(),
  recipientState: z.string().nullable(),
  recipientZip: z.string().nullable(),
  recipientCountry: z.string().nullable(),
  customs: z
    .object({
      description: z.string().nullable(),
      value: z.number().nullable(),
      quantity: z.number().nullable(),
      weight: z.number().nullable(),
      hsTariff: z.string().nullable(),
      countryOfOrigin: z.string().nullable(),
    })
    .nullable(),
});

export type ParsedShipment = z.infer<typeof parsedShipmentSchema>;

export interface ParsedShipmentWithMatch extends ParsedShipment {
  rowIndex: number;
  orgMatch: OrgMatchResult;
}

export interface OrgMatchResult {
  matched: boolean;
  orgId: string | null;
  orgName: string | null;
  matchedOn: string | null;
}

export interface ParseXlsxResult {
  shipments: ParsedShipmentWithMatch[];
  totalRows: number;
  parseErrors: ParseError[];
  columnMap: Record<string, number>;
}

export interface ParseError {
  rowIndex: number;
  message: string;
}

// --- Carrier inference from tracking number format ---

export function inferCarrierFromTracking(trackingNumber: string | null): {
  carrier: string | null;
  service: string | null;
} {
  if (!trackingNumber) return { carrier: null, service: null };
  if (trackingNumber.startsWith("AHOY")) {
    return { carrier: "Asendia", service: "International" };
  }
  if (/^\d{20,34}$/.test(trackingNumber)) {
    return { carrier: "USPS", service: null };
  }
  if (trackingNumber.startsWith("1Z")) {
    return { carrier: "UPS", service: null };
  }
  if (/^\d{12}$/.test(trackingNumber) || /^\d{15}$/.test(trackingNumber)) {
    return { carrier: "FedEx", service: null };
  }
  return { carrier: null, service: null };
}

// --- Core parser ---

export function parseXlsx(buffer: Buffer): {
  shipments: (ParsedShipment & { rowIndex: number })[];
  totalRows: number;
  parseErrors: ParseError[];
  columnMap: Record<string, number>;
} {
  const entries = readZipEntries(buffer);

  // Find shared strings
  const ssEntry = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const sharedStrings = ssEntry ? parseSharedStrings(ssEntry.data.toString("utf8")) : [];

  // Find first worksheet
  const sheetEntry = entries.find(
    (e) => e.name === "xl/worksheets/sheet1.xml" || e.name.match(/^xl\/worksheets\/sheet\d+\.xml$/),
  );
  if (!sheetEntry) {
    throw new Error("No worksheet found in XLSX file");
  }

  const rows = parseSheet(sheetEntry.data.toString("utf8"), sharedStrings);
  if (rows.length < 2) {
    return { shipments: [], totalRows: 0, parseErrors: [], columnMap: {} };
  }

  const headerRow = rows[0];
  const colMap = buildColumnMap(headerRow);

  // Validate required columns
  if (!colMap.has("trackingNumber") && !colMap.has("orderNumber")) {
    throw new Error(
      "XLSX missing required columns. Expected at least 'Tracking Number' or 'Order Number'. " +
        `Found headers: ${headerRow.join(", ")}`,
    );
  }

  const shipments: (ParsedShipment & { rowIndex: number })[] = [];
  const parseErrors: ParseError[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    // Skip completely empty rows
    if (row.every((cell) => cell.trim() === "")) continue;

    try {
      const get = (key: ColumnKey): string | null => {
        const idx = colMap.get(key);
        if (idx === undefined) return null;
        const val = row[idx]?.trim() ?? "";
        return val === "" ? null : val;
      };

      const getNum = (key: ColumnKey): number | null => {
        const raw = get(key);
        if (raw === null) return null;
        // Strip currency symbols and commas
        const cleaned = raw.replace(/[$,]/g, "");
        const num = Number.parseFloat(cleaned);
        return Number.isNaN(num) ? null : num;
      };

      // Must have at least a tracking number or order number
      const trackingNumber = get("trackingNumber");
      const orderNumber = get("orderNumber");
      if (!trackingNumber && !orderNumber) {
        parseErrors.push({
          rowIndex: i + 1,
          message: "Row missing both tracking number and order number",
        });
        continue;
      }

      const hasCustoms =
        get("customsDescription") !== null ||
        getNum("customsValue") !== null ||
        get("customsHsTariff") !== null;

      const rawCarrier = get("carrier");
      const rawService = get("service");
      const inferred = !rawCarrier ? inferCarrierFromTracking(trackingNumber) : null;

      const shipment: ParsedShipment & { rowIndex: number } = {
        rowIndex: i + 1, // 1-based for user display
        orderNumber,
        trackingNumber,
        carrier: rawCarrier ?? inferred?.carrier ?? null,
        service: rawService ?? inferred?.service ?? null,
        shipDate: get("shipDate"),
        weight: getNum("weight"),
        cost: getNum("cost"),
        email: get("email"),
        recipientName: get("recipientName"),
        recipientCompany: get("recipientCompany"),
        recipientAddress1: get("recipientAddress1"),
        recipientAddress2: get("recipientAddress2"),
        recipientCity: get("recipientCity"),
        recipientState: get("recipientState"),
        recipientZip: get("recipientZip"),
        recipientCountry: get("recipientCountry"),
        customs: hasCustoms
          ? {
              description: get("customsDescription"),
              value: getNum("customsValue"),
              quantity: getNum("customsQuantity"),
              weight: getNum("customsWeight"),
              hsTariff: get("customsHsTariff"),
              countryOfOrigin: get("customsCountryOfOrigin"),
            }
          : null,
      };

      shipments.push(shipment);
    } catch (err) {
      parseErrors.push({
        rowIndex: i + 1,
        message: err instanceof Error ? err.message : "Unknown parse error",
      });
    }
  }

  const columnMapRecord: Record<string, number> = {};
  colMap.forEach((idx, key) => {
    columnMapRecord[key] = idx;
  });

  return {
    shipments,
    totalRows: rows.length - 1, // exclude header
    parseErrors,
    columnMap: columnMapRecord,
  };
}

// --- Org matching ---

export async function matchOrgByPirateShipName(
  recipientName: string | null,
  recipientCompany: string | null,
  workspaceId: string,
  // biome-ignore lint/suspicious/noExplicitAny: Supabase client generic is too complex to type inline
  supabase: any,
): Promise<OrgMatchResult> {
  if (!recipientName && !recipientCompany) {
    return { matched: false, orgId: null, orgName: null, matchedOn: null };
  }

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, pirate_ship_name")
    .eq("workspace_id", workspaceId)
    .not("pirate_ship_name", "is", null);

  if (!orgs || orgs.length === 0) {
    return { matched: false, orgId: null, orgName: null, matchedOn: null };
  }

  // Try matching against pirate_ship_name (case-insensitive)
  const namesToCheck = [recipientName, recipientCompany].filter(Boolean) as string[];

  for (const name of namesToCheck) {
    const normalizedName = name.toLowerCase().trim();
    for (const org of orgs) {
      if (org.pirate_ship_name.toLowerCase().trim() === normalizedName) {
        return {
          matched: true,
          orgId: org.id,
          orgName: org.name,
          matchedOn: name,
        };
      }
    }
  }

  // Try partial/contains match as fallback
  for (const name of namesToCheck) {
    const normalizedName = name.toLowerCase().trim();
    for (const org of orgs) {
      const psName = org.pirate_ship_name.toLowerCase().trim();
      if (normalizedName.includes(psName) || psName.includes(normalizedName)) {
        return {
          matched: true,
          orgId: org.id,
          orgName: org.name,
          matchedOn: name,
        };
      }
    }
  }

  return { matched: false, orgId: null, orgName: null, matchedOn: null };
}
