/**
 * Step 0: Bandcamp data-tralbum diagnostic
 * Standalone — no project imports, no he package needed.
 *
 * Run: node scripts/test-bandcamp-scrape.mjs
 */

const TEST_URLS = [
  "https://neurosis.bandcamp.com/album/an-undying-love-for-a-burning-world",
  "https://northernspyrecords.bandcamp.com/album/travel",
  "https://northernspyrecords.bandcamp.com/album/the-necks-travel",
  "https://northernspyrecords.bandcamp.com/album/disquiet",
];

function decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

async function scrape(url) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`URL: ${url}`);
  console.log("=".repeat(70));

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      console.log(`FAIL HTTP ${res.status}`);
      return;
    }
    html = await res.text();
  } catch (err) {
    console.log(`FAIL fetch error: ${err}`);
    return;
  }

  // Check for data-tralbum attribute
  const attrMatch = html.match(/data-tralbum="([^"]+)"/);
  if (!attrMatch) {
    console.log("FAIL: data-tralbum attribute NOT FOUND");
    console.log("  Checking for TralbumData JS var...");
    const jsMatch = html.match(/var\s+TralbumData\s*=/);
    console.log(jsMatch ? "  FOUND: TralbumData JS var (V2 format)" : "  NOT FOUND either");
    return;
  }

  console.log("PASS: data-tralbum attribute found");

  let data;
  try {
    const decoded = decodeEntities(attrMatch[1]);
    data = JSON.parse(decoded);
  } catch (err) {
    console.log(`FAIL parse error: ${err}`);
    return;
  }

  // Top-level fields
  console.log("\n--- Top-level ---");
  console.log("art_id:             ", data.art_id ?? "NULL");
  console.log("is_preorder:        ", data.is_preorder ?? "NULL");
  console.log("album_is_preorder:  ", data.album_is_preorder ?? "NULL");
  console.log("current.title:      ", data.current?.title ?? "NULL");
  console.log("current.release_date:", data.current?.release_date ?? "NULL");

  // Album art URL
  if (data.art_id) {
    console.log("album_art_url:      ", `https://f4.bcbits.com/img/a${data.art_id}_10.jpg`);
  }

  // Packages
  const pkgs = data.packages ?? [];
  console.log(`\n--- Packages (${pkgs.length}) ---`);
  for (const pkg of pkgs) {
    console.log(`\n  [${pkg.type_name ?? "?"}] type_id=${pkg.type_id ?? "?"}`);
    console.log(`    sku:          ${pkg.sku ?? "NULL"}`);
    console.log(`    release_date: ${pkg.release_date ?? "NULL"}`);
    console.log(`    new_date:     ${pkg.new_date ?? "NULL"}`);
    console.log(`    image_id:     ${pkg.image_id ?? "NULL"}`);
    const arts = pkg.arts ?? [];
    console.log(`    arts count:   ${arts.length}`);
    if (arts.length > 0) {
      for (const art of arts) {
        console.log(`      art image_id: ${art.image_id ?? "NULL"}`);
        if (art.image_id) {
          console.log(`      art url:      https://f4.bcbits.com/img/${art.image_id}_10.jpg`);
        }
      }
    }
    if (pkg.image_id) {
      console.log(`    primary_img:  https://f4.bcbits.com/img/${pkg.image_id}_10.jpg`);
    }
  }

  console.log("\n--- Checklist ---");
  console.log(`[ ${data.art_id ? "✓" : "✗"} ] art_id present`);
  console.log(`[ ${data.current?.release_date ? "✓" : "✗"} ] current.release_date present`);
  console.log(`[ ${typeof data.is_preorder === "boolean" ? "✓" : "✗"} ] is_preorder boolean`);
  console.log(`[ ${pkgs.length > 0 ? "✓" : "✗"} ] packages array present`);
  console.log(`[ ${pkgs.some(p => p.sku) ? "✓" : "✗"} ] at least one package has SKU`);
  console.log(`[ ${pkgs.some(p => p.type_id) ? "✓" : "✗"} ] at least one package has type_id`);
  console.log(`[ ${pkgs.some(p => (p.arts ?? []).length > 0) ? "✓" : "✗"} ] at least one package has arts`);
}

async function main() {
  for (const url of TEST_URLS) {
    await scrape(url);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log("\n\nDone.");
}

main().catch(console.error);
