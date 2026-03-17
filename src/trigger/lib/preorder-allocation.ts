/**
 * FIFO pre-order allocation logic (Rule #69).
 *
 * When a pressing plant short-ships (300 received vs 450 pre-orders),
 * which orders get released matters. Allocate via ORDER BY created_at ASC.
 * When available stock hits 0, remaining orders stay pending and a
 * short_shipment review queue item is created.
 */

export interface PreorderOrder {
  id: string;
  created_at: string;
  quantity: number;
}

export interface AllocationResult {
  allocated: Array<{ orderId: string; quantity: number }>;
  unallocated: Array<{ orderId: string; quantity: number }>;
  totalAllocated: number;
  totalUnallocated: number;
  isShortShipment: boolean;
}

/**
 * Allocates available inventory to pre-orders in FIFO order (oldest first).
 * Pure function — no side effects, fully testable.
 *
 * @param orders - Pre-orders sorted by created_at ASC (FIFO)
 * @param availableStock - Current available inventory for the SKU
 * @param alreadyAllocatedOrderIds - Set of order IDs that were already allocated (for idempotency)
 */
export function allocatePreorders(
  orders: PreorderOrder[],
  availableStock: number,
  alreadyAllocatedOrderIds: Set<string> = new Set(),
): AllocationResult {
  const allocated: Array<{ orderId: string; quantity: number }> = [];
  const unallocated: Array<{ orderId: string; quantity: number }> = [];
  let remaining = availableStock;

  // Sort by created_at ASC to enforce FIFO
  const sorted = [...orders].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const order of sorted) {
    // Skip already-allocated orders (idempotency)
    if (alreadyAllocatedOrderIds.has(order.id)) {
      continue;
    }

    if (remaining >= order.quantity) {
      allocated.push({ orderId: order.id, quantity: order.quantity });
      remaining -= order.quantity;
    } else {
      unallocated.push({ orderId: order.id, quantity: order.quantity });
    }
  }

  const totalAllocated = allocated.reduce((sum, a) => sum + a.quantity, 0);
  const totalUnallocated = unallocated.reduce((sum, u) => sum + u.quantity, 0);

  return {
    allocated,
    unallocated,
    totalAllocated,
    totalUnallocated,
    isShortShipment: unallocated.length > 0,
  };
}
