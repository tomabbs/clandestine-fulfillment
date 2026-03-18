#!/usr/bin/env node

/**
 * truth-run.mjs — Nightly entrypoint for all truth-layer sensor runners.
 *
 * Runs each sensor domain sequentially so they don't compete for DB connections.
 * Exit code is non-zero if any domain fails.
 *
 * Usage:
 *   node scripts/truth-run.mjs              # run all domains
 *   node scripts/truth-run.mjs inventory    # run specific domain(s)
 *   node scripts/truth-run.mjs sync platform
 */

import "dotenv/config";
import { runSensorDomain } from "./truth-sensors/_shared.mjs";

const DOMAIN_MAP = {
  connection: () => import("./truth-sensors/run-connection-sensors.mjs"),
  sync: () => import("./truth-sensors/run-sync-sensors.mjs"),
  inventory: () => import("./truth-sensors/run-inventory-sensors.mjs"),
  preorder: () => import("./truth-sensors/run-preorder-sensors.mjs"),
  platform: () => import("./truth-sensors/run-platform-sensors.mjs"),
};

const ALL_DOMAINS = Object.keys(DOMAIN_MAP);

async function main() {
  const start = Date.now();
  const args = process.argv.slice(2);
  const domains = args.length > 0 ? args : ALL_DOMAINS;

  // Validate domain names
  for (const d of domains) {
    if (!ALL_DOMAINS.includes(d)) {
      console.error(`Unknown domain: "${d}". Valid domains: ${ALL_DOMAINS.join(", ")}`);
      process.exit(1);
    }
  }

  console.log("=== Truth Layer Sensor Run ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Domains: ${domains.join(", ")}`);
  console.log("");

  const results = {};
  let hasFailure = false;

  for (const domain of domains) {
    try {
      const mod = await DOMAIN_MAP[domain]();
      await runSensorDomain(`${domain}-sensors`, mod.collectReadings);
      results[domain] = "ok";
    } catch (err) {
      results[domain] = `FAILED: ${err.message}`;
      hasFailure = true;
    }
    console.log("");
  }

  const elapsed = Date.now() - start;
  console.log("=== Summary ===");
  for (const [domain, status] of Object.entries(results)) {
    console.log(`  ${domain}: ${status}`);
  }
  console.log(`Total time: ${elapsed}ms`);

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main();
