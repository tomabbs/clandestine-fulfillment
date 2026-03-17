import { deflateRawSync } from "node:zlib";

/**
 * Builds a minimal valid XLSX file (ZIP containing XML) for testing.
 * XLSX = ZIP archive with:
 *   - xl/sharedStrings.xml (string table)
 *   - xl/worksheets/sheet1.xml (cell data)
 *   - [Content_Types].xml (required)
 *   - xl/workbook.xml (required)
 *   - xl/_rels/workbook.xml.rels (required)
 */
export function buildTestXlsx(rows: string[][]): Buffer {
  // Build shared strings
  const allStrings: string[] = [];
  const stringIndexMap = new Map<string, number>();

  for (const row of rows) {
    for (const cell of row) {
      if (cell !== "" && !stringIndexMap.has(cell)) {
        stringIndexMap.set(cell, allStrings.length);
        allStrings.push(cell);
      }
    }
  }

  const escapeXml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${allStrings.length}" uniqueCount="${allStrings.length}">
${allStrings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("\n")}
</sst>`;

  // Build sheet XML
  const colLetter = (idx: number): string => {
    let result = "";
    let n = idx;
    while (n >= 0) {
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    }
    return result;
  };

  let sheetRows = "";
  for (let r = 0; r < rows.length; r++) {
    let cells = "";
    for (let c = 0; c < rows[r].length; c++) {
      const val = rows[r][c];
      if (val === "") continue;
      const ref = `${colLetter(c)}${r + 1}`;
      const numVal = Number(val);
      if (!Number.isNaN(numVal) && val.trim() !== "") {
        // Numeric value
        cells += `<c r="${ref}"><v>${val}</v></c>`;
      } else {
        // String value — use shared string index
        const idx = stringIndexMap.get(val);
        cells += `<c r="${ref}" t="s"><v>${idx}</v></c>`;
      }
    }
    sheetRows += `<row r="${r + 1}">${cells}</row>\n`;
  }

  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
${sheetRows}
</sheetData>
</worksheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets>
</workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  // Build ZIP file
  const files: { name: string; data: Buffer }[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml) },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(relsXml) },
    { name: "xl/sharedStrings.xml", data: Buffer.from(sharedStringsXml) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml) },
  ];

  return buildZip(files);
}

function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  const offsets: number[] = [];
  let currentOffset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);

    // Local file header
    const local = Buffer.alloc(30 + nameBuffer.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc32(file.data), 14); // crc32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(file.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length
    nameBuffer.copy(local, 30);
    compressed.copy(local, 30 + nameBuffer.length);

    offsets.push(currentOffset);
    localHeaders.push(local);
    currentOffset += local.length;

    // Central directory header
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // compression: deflate
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc32(file.data), 16); // crc32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(file.data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuffer.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offsets[offsets.length - 1], 42); // local header offset
    nameBuffer.copy(central, 46);

    centralHeaders.push(central);
  }

  const centralDirOffset = currentOffset;
  let centralDirSize = 0;
  for (const h of centralHeaders) centralDirSize += h.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// CRC32 implementation for ZIP
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Pre-built test data ---

export const SAMPLE_HEADERS = [
  "Order Number",
  "Tracking Number",
  "Carrier",
  "Service",
  "Ship Date",
  "Weight",
  "Cost",
  "Recipient Name",
  "Recipient Company",
  "Address 1",
  "Address 2",
  "City",
  "State",
  "Zip",
  "Country",
];

export const SAMPLE_ROW_1 = [
  "ORD-001",
  "1Z999AA10123456784",
  "UPS",
  "Ground",
  "2026-03-15",
  "2.5",
  "8.99",
  "Fat Possum Records",
  "",
  "123 Main St",
  "Suite 4",
  "Oxford",
  "MS",
  "38655",
  "US",
];

export const SAMPLE_ROW_2 = [
  "ORD-002",
  "9400111899223100001",
  "USPS",
  "Priority",
  "2026-03-15",
  "1.2",
  "5.50",
  "Unknown Label Co",
  "",
  "456 Oak Ave",
  "",
  "Nashville",
  "TN",
  "37203",
  "US",
];

export const SAMPLE_ROW_INTERNATIONAL = [
  "Order Number",
  "Tracking Number",
  "Carrier",
  "Service",
  "Ship Date",
  "Weight",
  "Cost",
  "Recipient Name",
  "Recipient Company",
  "Address 1",
  "Address 2",
  "City",
  "State",
  "Zip",
  "Country",
  "Customs Description",
  "Customs Value",
  "Customs Quantity",
  "HS Tariff",
  "Country of Origin",
];

export const INTL_DATA_ROW = [
  "ORD-003",
  "CP123456789GB",
  "Royal Mail",
  "International",
  "2026-03-15",
  "0.8",
  "15.00",
  "Rough Trade Records",
  "Rough Trade Ltd",
  "130 Talbot Rd",
  "",
  "London",
  "",
  "W11 1JA",
  "GB",
  "Vinyl Records",
  "25.00",
  "2",
  "8523.80",
  "US",
];
