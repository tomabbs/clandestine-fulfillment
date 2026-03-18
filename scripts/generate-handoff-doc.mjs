#!/usr/bin/env node
/**
 * Generates FULL_CODEBASE_TECHNICAL_HANDOFF_MASTER_2026-03-18.md
 * Run: node scripts/generate-handoff-doc.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outPath = path.join(root, "docs", "FULL_CODEBASE_TECHNICAL_HANDOFF_MASTER_2026-03-18.md");

function walk(dir, ext) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !["node_modules", ".next", ".git", "coverage", "dist", ".vercel", ".trigger"].includes(e.name)) {
      files.push(...walk(full, ext));
    } else if (e.isFile() && ext.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

function readSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return `// Error reading file: ${p}\n`;
  }
}

function langFromPath(p) {
  if (p.endsWith(".tsx") || p.endsWith(".jsx")) return "tsx";
  if (p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".mjs")) return "typescript";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".sql")) return "sql";
  if (p.endsWith(".json")) return "json";
  return "text";
}

const sections = [];

// Sections 1-8
const headerContent = [
  "# Clandestine Fulfillment — Full Codebase Technical Handoff",
  "**Generated:** 2026-03-18",
  "",
  "---",
  "",
  "## 1. Executive Technical Map",
  "### High-Level Architecture Overview",
  "Clandestine Fulfillment is a 3PL warehouse management app for independent record labels.",
  "Tech Stack: Next.js 14+ App Router, React 18, TypeScript, Tailwind, shadcn/ui, Supabase, Trigger.dev v4, Upstash Redis.",
  "",
  "---",
  "## 2. Runtime Architecture",
  "Next.js App Router, Server Actions, Route Handlers (webhooks only), Middleware (auth/roles), Trigger.dev background tasks.",
  "",
  "---",
  "## 3. Frontend Wiring Map",
  "Layouts: layout.tsx, (auth)/layout, admin/layout, portal/layout. Sidebars: admin-sidebar, portal-sidebar.",
  "",
  "---",
  "## 4. Backend Wiring Map",
  "Actions: admin-dashboard, auth, billing, catalog, clients, inbound, inventory, orders, shipping, support, etc.",
  "",
  "---",
  "## 5. API Endpoints Map",
  "/api/health, /api/webhooks/shopify, shipstation, client-store, stripe, aftership, resend-inbound.",
  "",
  "---",
  "## 6. Trigger.dev Setup and Task Graph",
  "Cron: bandcamp-sync, bandcamp-sale-poll, shopify-sync, shipstation-poll. Event: process-shopify-webhook, process-client-store-webhook, shipment-ingest.",
  "",
  "---",
  "## 7. Data Flow Maps",
  "Shopify: webhook -> process-shopify-webhook. Bandcamp: bandcamp-sync, bandcamp-sale-poll. ShipStation: webhook/poll -> shipment-ingest.",
  "",
  "---",
  "## 8. Known Gaps and Breakpoints",
  "BUG: Shopify webhook stores metadata: { topic } but process-shopify-webhook expects metadata.payload. BUG: Resend-inbound inserts payload but webhook_events has metadata column.",
  "",
  "---",
  "## 9. Appendix — Full Source Code",
  "",
].join("\n");

sections.push(headerContent);

// Appendix: src files
const srcFiles = walk(path.join(root, "src"), /\.(ts|tsx|css)$/).sort();
for (const p of srcFiles) {
  const rel = path.relative(root, p);
  const content = readSafe(p);
  const lang = langFromPath(p);
  sections.push(`### ${rel}\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`);
}

// Appendix: migrations
sections.push(`\n---\n\n### supabase/migrations\n\n`);
const migFiles = walk(path.join(root, "supabase", "migrations"), /\.sql$/).sort();
for (const p of migFiles) {
  const rel = path.relative(root, p);
  const content = readSafe(p);
  sections.push(`### ${rel}\n\`\`\`sql\n${content}\n\`\`\`\n\n`);
}

// Appendix: configs
const configs = [
  "package.json",
  "tsconfig.json",
  "biome.json",
  "vitest.config.ts",
  "playwright.config.ts",
  "trigger.config.ts",
  "sentry.client.config.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "middleware.ts",
  "components.json",
  "postcss.config.mjs",
  "instrumentation.ts",
  "next.config.mjs",
];
sections.push(`\n---\n\n### Root configs\n\n`);
for (const name of configs) {
  const p = path.join(root, name);
  if (fs.existsSync(p)) {
    const content = readSafe(p);
    sections.push(`### ${name}\n\`\`\`${langFromPath(p)}\n${content}\n\`\`\`\n\n`);
  }
}

// env template from parent
const credPath = path.join(root, "..", "CREDENTIALS_TEMPLATE.txt");
if (fs.existsSync(credPath)) {
  sections.push(`### CREDENTIALS_TEMPLATE.txt (parent)\n\`\`\`\n${readSafe(credPath)}\n\`\`\`\n\n`);
}

// scripts
const scriptFiles = [
  "trigger-backfill.ts",
  "backfill-shipments.ts",
  "backfill-shipment-items.ts",
  "poll-images.ts",
];
sections.push(`\n---\n\n### scripts (diagnostics/CI)\n\n`);
for (const name of scriptFiles) {
  const p = path.join(root, "scripts", name);
  if (fs.existsSync(p)) {
    const content = readSafe(p);
    sections.push(`### scripts/${name}\n\`\`\`typescript\n${content}\n\`\`\`\n\n`);
  }
}

// Summary
const total = srcFiles.length + migFiles.length + configs.filter((c) => fs.existsSync(path.join(root, c))).length + (fs.existsSync(credPath) ? 1 : 0) + scriptFiles.filter((s) => fs.existsSync(path.join(root, "scripts", s))).length;
sections.push(`---

## Summary

- **Total files embedded:** ${total}
- **Major sections:** Executive map, Runtime architecture, Frontend wiring, Backend wiring, API endpoints, Trigger.dev task graph, Data flow maps, Known gaps, Appendix
- **Skipped:** node_modules, .next, .git, coverage, dist, pnpm-lock.yaml, tsconfig.tsbuildinfo, .vercel, .trigger, .DS_Store
`);

fs.writeFileSync(outPath, sections.join(""), "utf8");
console.log(`Wrote ${outPath}`);
console.log(`  src files: ${srcFiles.length}`);
console.log(`  migrations: ${migFiles.length}`);
console.log(`  configs: ${configs.length}`);
console.log(`  scripts: ${scriptFiles.length}`);