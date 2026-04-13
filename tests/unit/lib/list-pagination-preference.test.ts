import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeListPageSize,
  readListPaginationPrefs,
  writeListPaginationPrefs,
} from "@/lib/shared/list-pagination-preference";

const KEY = "test-route";

afterEach(() => {
  sessionStorage.clear();
});

describe("list-pagination-preference", () => {
  it("round-trips page and pageSize", () => {
    writeListPaginationPrefs(KEY, { page: 3, pageSize: 100 });
    expect(readListPaginationPrefs(KEY)).toEqual({ page: 3, pageSize: 100 });
  });

  it("normalizes invalid stored pageSize", () => {
    sessionStorage.setItem("cf:list-pag:v1:bad", JSON.stringify({ page: 1, pageSize: 999 }));
    expect(readListPaginationPrefs("bad")).toEqual({ page: 1, pageSize: 50 });
  });

  it("normalizeListPageSize coerces unknown numbers", () => {
    expect(normalizeListPageSize(250)).toBe(250);
    expect(normalizeListPageSize(12)).toBe(50);
  });
});
