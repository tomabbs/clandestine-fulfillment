/** Mirrors `PaginationBar` / catalog actions — keep in sync with `PAGE_SIZES` in pagination-bar. */
const PAGE_SIZES = [50, 100, 250] as const;
export type ListPageSize = (typeof PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: ListPageSize = 50;

const STORAGE_PREFIX = "cf:list-pag:v1:";

export type ListPaginationPrefs = {
  page: number;
  pageSize: ListPageSize;
};

function isPageSize(n: unknown): n is ListPageSize {
  return typeof n === "number" && (PAGE_SIZES as readonly number[]).includes(n);
}

/** SSR-safe: returns defaults when `sessionStorage` is unavailable. */
export function readListPaginationPrefs(routeKey: string): ListPaginationPrefs {
  if (typeof sessionStorage === "undefined") {
    return { page: 1, pageSize: DEFAULT_PAGE_SIZE };
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + routeKey);
    if (!raw) return { page: 1, pageSize: DEFAULT_PAGE_SIZE };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pageSize: ListPageSize = isPageSize(parsed.pageSize)
      ? parsed.pageSize
      : DEFAULT_PAGE_SIZE;
    const page = Math.max(1, Math.floor(Number(parsed.page)) || 1);
    return { page, pageSize };
  } catch {
    return { page: 1, pageSize: DEFAULT_PAGE_SIZE };
  }
}

export function writeListPaginationPrefs(routeKey: string, prefs: ListPaginationPrefs): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_PREFIX + routeKey, JSON.stringify(prefs));
  } catch {
    // ignore quota / private mode
  }
}

/** Coerce any numeric page size to a valid list row count (50 / 100 / 250). */
export function normalizeListPageSize(n: number): ListPageSize {
  if (isPageSize(n)) return n;
  return DEFAULT_PAGE_SIZE;
}
