"use client";

import type { Dispatch, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { PageSize } from "@/components/shared/pagination-bar";
import {
  normalizeListPageSize,
  readListPaginationPrefs,
  writeListPaginationPrefs,
} from "@/lib/shared/list-pagination-preference";

/**
 * Restores page + pageSize from sessionStorage once on mount, and persists on change.
 * Use a stable `routeKey` per list screen (e.g. `admin/catalog`, `portal/inventory`).
 */
export function useListPaginationPreference<T extends { page: number; pageSize: number }>(
  routeKey: string,
  filters: T,
  setFilters: Dispatch<SetStateAction<T>>,
): void {
  const skipFirstPersist = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; routeKey is fixed per screen
  useLayoutEffect(() => {
    const prefs = readListPaginationPrefs(routeKey);
    setFilters((f) => ({ ...f, page: prefs.page, pageSize: prefs.pageSize }));
  }, []);

  useEffect(() => {
    if (skipFirstPersist.current) {
      skipFirstPersist.current = false;
      return;
    }
    writeListPaginationPrefs(routeKey, {
      page: filters.page,
      pageSize: normalizeListPageSize(filters.pageSize),
    });
  }, [routeKey, filters.page, filters.pageSize]);
}

/**
 * Same persistence for pages that keep `page` and `pageSize` in separate `useState` calls.
 */
export function useListPaginationPreferenceSplit(
  routeKey: string,
  page: number,
  pageSize: PageSize,
  setPage: Dispatch<SetStateAction<number>>,
  setPageSize: Dispatch<SetStateAction<PageSize>>,
): void {
  const skipFirstPersist = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; routeKey is fixed per screen
  useLayoutEffect(() => {
    const prefs = readListPaginationPrefs(routeKey);
    setPage(prefs.page);
    setPageSize(prefs.pageSize);
  }, []);

  useEffect(() => {
    if (skipFirstPersist.current) {
      skipFirstPersist.current = false;
      return;
    }
    writeListPaginationPrefs(routeKey, { page, pageSize });
  }, [routeKey, page, pageSize]);
}
