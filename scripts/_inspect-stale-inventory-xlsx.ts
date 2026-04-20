import * as XLSX from "xlsx";

const FILES = [
  "/Users/tomabbs/Downloads/avant 1.xlsx",
  "/Users/tomabbs/Downloads/redeye over.xlsx",
  "/Users/tomabbs/Downloads/gr.xlsx",
  "/Users/tomabbs/Downloads/anacortes.xlsx",
  "/Users/tomabbs/Downloads/Master page.xlsx",
];

for (const f of FILES) {
  console.log(`\n=== ${f} ===`);
  const wb = XLSX.readFile(f);
  for (const sheetName of wb.SheetNames) {
    const sh = wb.Sheets[sheetName];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "", raw: false });
    let nonEmpty = 0;
    let withSku = 0;
    let withTitle = 0;
    for (const r of rows) {
      if (!Array.isArray(r)) continue;
      const hasAny = r.some((c) => String(c ?? "").trim() !== "");
      if (hasAny) nonEmpty++;
      // SKU is usually col B (index 1) for non-avant, col B (1) for avant too
      const skuCellB = String(r[1] ?? "").trim();
      const skuCellA = String(r[0] ?? "").trim();
      if (skuCellB && skuCellB.toLowerCase() !== "sku") withSku++;
      const longCell = r.some((c) => String(c ?? "").trim().length > 8);
      if (longCell) withTitle++;
    }
    console.log(`  sheet="${sheetName}" total_rows=${rows.length} non_empty=${nonEmpty} with_sku_in_colB=${withSku}`);
    // Sample of last 5 rows that have content
    const samples: number[] = [];
    for (let i = rows.length - 1; i >= 0 && samples.length < 5; i--) {
      const r = rows[i];
      if (Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== "")) {
        samples.unshift(i);
      }
    }
    for (const i of samples) {
      const r = rows[i];
      console.log(
        `    last r${i}: ${(r as unknown[]).slice(0, 8).map((c) => `"${String(c).slice(0, 25)}"`).join(" | ")}`,
      );
    }
  }
}
