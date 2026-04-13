import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Bandcamp order `line_items` JSON often repeats `shipping` on each row; take the max. */
export function maxShippingFromOrderLineItems(lineItems: unknown): number | null {
  if (!Array.isArray(lineItems)) return null
  let m = 0
  for (const row of lineItems) {
    if (row && typeof row === "object" && "shipping" in row) {
      const v = Number((row as { shipping?: unknown }).shipping)
      if (!Number.isNaN(v)) m = Math.max(m, v)
    }
  }
  return m > 0 ? m : null
}
