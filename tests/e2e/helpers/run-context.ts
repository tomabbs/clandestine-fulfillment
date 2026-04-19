const RUN_ID =
  process.env.PLAYWRIGHT_TEST_RUN_ID ??
  process.env.E2E_RUN_ID ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const WORKER_ID = process.env.PLAYWRIGHT_WORKER_INDEX ?? "0";

export const E2E_TEST_PREFIX = "e2e-test-";
export const E2E_NAMESPACE = `${E2E_TEST_PREFIX}${RUN_ID}-w${WORKER_ID}`;

export function namespacedValue(value: string): string {
  return `${E2E_NAMESPACE}-${value}`;
}
