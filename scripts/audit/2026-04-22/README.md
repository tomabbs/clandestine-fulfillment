# 2026-04-22 audit pass — scratch scripts

These scripts are one-off helpers used during the **direct-shopify cutover
finish-line** audit pass on 2026-04-22. They are not part of the regular
operator toolchain and **must not** be referenced from CI, runbooks, or
release-gate scripts.

They live here for forensic value (and so the audit reports they reference
remain reproducible) until the deferred follow-up `northern-spy-scratch-removal`
(see [`docs/DEFERRED_FOLLOWUPS.md`](../../../docs/DEFERRED_FOLLOWUPS.md))
flips them for permanent deletion or formal promotion.

| Script | Purpose |
|---|---|
| `_inspect-northern-spy-connection.ts` | Read-only dump of the Northern Spy `client_store_connections` row used to verify HRD-35 gap #3 webhook auto-register. |
| `_inspect-northern-spy-org.ts` | Read-only dump of the Northern Spy `organizations` row used to confirm the org-merge RPC's expectations. |
| `_reassign-shopify-conn-to-northern-spy.ts` | One-off ownership move executed once during the audit. Do not re-run. |
| `_verify-northern-spy-reassignment.ts` | Post-move read-only verification. |

Default action by `due_date` (2026-05-15): delete the directory unless an
operator has needed to re-run any of the inspectors.
