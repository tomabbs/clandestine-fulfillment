// One-shot operator helper — provision the Resend webhook for the unified
// email pipeline. Returns the signing secret you must paste into Vercel env
// as RESEND_WEBHOOK_SECRET.
//
// Idempotency: this script LISTS first; if a webhook already exists for our
// endpoint, it prints the existing one (without re-fetching the secret —
// Resend only returns the secret at creation time, so re-running won't
// re-surface it). To get a fresh secret, delete the existing webhook in
// the Resend dashboard first.

import { Resend } from "resend";
import "dotenv/config";

const ENDPOINT = "https://cpanel.clandestinedistro.com/api/webhooks/resend";
const EVENTS = [
  "email.delivered",
  "email.bounced",
  "email.complained",
] as const;

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY missing");
  const resend = new Resend(apiKey);

  const list = await resend.webhooks.list();
  if (list.error) throw new Error(`webhooks.list failed: ${list.error.message}`);

  const existing = list.data?.data?.find((w) => w.endpoint === ENDPOINT);
  if (existing) {
    console.log(`\n✓ Webhook ALREADY exists for ${ENDPOINT}:\n`);
    console.log(`  id:         ${existing.id}`);
    console.log(`  status:     ${existing.status}`);
    console.log(`  events:     ${(existing.events ?? []).join(", ")}`);
    console.log(`  created_at: ${existing.created_at}`);
    console.log(
      "\n  ⚠ Resend doesn't expose the signing secret after creation.",
    );
    console.log(
      "  If you need a fresh secret: delete this webhook in the Resend dashboard, then re-run.\n",
    );
    return;
  }

  console.log(`Creating webhook → ${ENDPOINT}`);
  const created = await resend.webhooks.create({
    endpoint: ENDPOINT,
    events: [...EVENTS],
  });
  if (created.error) throw new Error(`webhooks.create failed: ${created.error.message}`);
  if (!created.data) throw new Error("webhooks.create returned no data");

  console.log(`\n✓ CREATED — id: ${created.data.id}`);
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`SIGNING SECRET (paste into Vercel as RESEND_WEBHOOK_SECRET):`);
  console.log(`\n  ${created.data.signing_secret}\n`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`Events subscribed: ${EVENTS.join(", ")}`);
  console.log(`Endpoint:          ${ENDPOINT}`);
  console.log(`\nNext: paste the secret into Vercel env (Project → Settings → Environment Variables).`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
