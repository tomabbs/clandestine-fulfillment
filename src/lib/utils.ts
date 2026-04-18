/**
 * @deprecated 2026-04-13 — moved to `src/lib/shared/utils.ts` per Rule #57.
 *
 * This module exists only as a re-export shim so existing imports of
 * `@/lib/utils` continue to compile during the deferred-followup migration
 * cycle (`shared-utils-path` slug). New imports should target
 * `@/lib/shared/utils`. Schedule removal: when no `from "@/lib/utils"`
 * imports remain (`rg "from .@/lib/utils.$" --type ts`).
 */
export { cn, formatRelativeTimeShort, maxShippingFromOrderLineItems } from "@/lib/shared/utils";
