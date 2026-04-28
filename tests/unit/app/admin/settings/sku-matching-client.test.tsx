import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerRefresh = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: routerRefresh,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: (props: { position?: string }) => (
    <div data-position={props.position} data-testid="sku-matching-toaster" />
  ),
}));

const createOrUpdateSkuMatch = vi.fn();
const previewSkuMatch = vi.fn();
const rejectSkuMatchCandidate = vi.fn();
const searchSkuRemoteCatalog = vi.fn();

vi.mock("@/actions/sku-matching", () => ({
  acceptExactMatches: vi.fn(),
  activateShopifyInventoryAtDefaultLocation: vi.fn(),
  createOrUpdateSkuMatch: (...args: unknown[]) => createOrUpdateSkuMatch(...args),
  deactivateSkuMatch: vi.fn(),
  enableSkuMatchingFeatureFlag: vi.fn(),
  previewSkuMatch: (...args: unknown[]) => previewSkuMatch(...args),
  rejectSkuMatchCandidate: (...args: unknown[]) => rejectSkuMatchCandidate(...args),
  searchSkuRemoteCatalog: (...args: unknown[]) => searchSkuRemoteCatalog(...args),
}));

import type { SkuMatchingWorkspaceData } from "@/actions/sku-matching";
import { SkuMatchingClient } from "@/app/admin/settings/sku-matching/sku-matching-client";

const connection = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  orgName: "Northern Spy",
  platform: "shopify" as const,
  storeUrl: "https://northernspy.example",
  connectionStatus: "active",
  activeMappingCount: 0,
  isShopifyReady: true,
  defaultLocationId: "gid://shopify/Location/1",
};

const candidate = {
  remote: {
    platform: "shopify" as const,
    remoteProductId: "gid://shopify/Product/1",
    remoteVariantId: "gid://shopify/ProductVariant/1",
    remoteInventoryItemId: "gid://shopify/InventoryItem/1",
    remoteSku: "NS-001",
    productTitle: "Northern Spy Product",
    variantTitle: "LP",
    combinedTitle: "Northern Spy Product - LP",
    productType: "LP",
    productUrl: "https://northernspy.example/products/northern-spy-product",
    price: 24,
    barcode: null,
    quantity: 3,
  },
  score: 100,
  confidenceTier: "deterministic" as const,
  matchMethod: "exact_sku" as const,
  reasons: ["Exact SKU match"],
  disqualifiers: [],
};

function workspace(overrides: Partial<SkuMatchingWorkspaceData> = {}): SkuMatchingWorkspaceData {
  return {
    featureEnabled: true,
    connection,
    remoteCatalogState: "ok",
    remoteCatalogError: null,
    fetchedAt: "2026-04-27T10:00:00.000Z",
    rows: [
      {
        variantId: "33333333-3333-4333-8333-333333333333",
        productId: "44444444-4444-4444-8444-444444444444",
        canonicalOrgId: "55555555-5555-4555-8555-555555555555",
        canonicalOrgName: "Northern Spy Records",
        canonicalSku: "NS-001",
        artist: "Northern Spy",
        canonicalTitle: "Northern Spy Product",
        bandcampTitle: "Northern Spy Product",
        bandcampUrl: "https://northernspy.bandcamp.com/album/product",
        format: "LP",
        variantTitle: "LP",
        barcode: null,
        price: 24,
        available: 5,
        committed: 0,
        existingMappingId: null,
        remoteSku: candidate.remote.remoteSku,
        remoteProductId: candidate.remote.remoteProductId,
        remoteVariantId: candidate.remote.remoteVariantId,
        remoteInventoryItemId: candidate.remote.remoteInventoryItemId,
        matchMethod: null,
        matchConfidence: null,
        topCandidate: candidate,
        rowStatus: "needs_review_low_confidence",
        candidateFingerprint: "fingerprint-1",
        discogs: null,
      },
    ],
    remoteOnlyRows: [],
    matchedCount: 0,
    needsReviewCount: 1,
    remoteOnlyCount: 0,
    conflictCount: 0,
    canonicalDuplicateConflicts: [],
    remoteDuplicateConflicts: [],
    existingSyncConflicts: [],
    ...overrides,
  };
}

function renderClient(data = workspace()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SkuMatchingClient
        clients={[
          { id: connection.orgId, name: "Northern Spy", connectionCount: 1 },
          { id: "55555555-5555-4555-8555-555555555555", name: "True Panther", connectionCount: 1 },
        ]}
        connections={[
          connection,
          {
            ...connection,
            id: "66666666-6666-4666-8666-666666666666",
            orgId: "55555555-5555-4555-8555-555555555555",
            orgName: "True Panther",
          },
        ]}
        selectedOrgId={connection.orgId}
        workspace={data}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
  previewSkuMatch.mockResolvedValue({
    canonical: {
      variantId: workspace().rows[0].variantId,
      sku: "NS-001",
      barcode: null,
      title: "Northern Spy Product",
      artist: "Northern Spy",
      format: "LP",
      bandcampTitle: "Northern Spy Product",
      bandcampUrl: "https://northernspy.bandcamp.com/album/product",
    },
    existingMapping: null,
    targetRemote: candidate.remote,
    targetError: null,
    candidate,
    fingerprint: "fingerprint-1",
    shopifyReadiness: null,
    remoteCatalogState: "ok",
    remoteCatalogError: null,
  });
  searchSkuRemoteCatalog.mockResolvedValue({
    results: [],
    remoteCatalogState: "ok",
    remoteCatalogError: null,
  });
  rejectSkuMatchCandidate.mockResolvedValue({
    rejected: true,
    alreadyExists: false,
    remoteKey: candidate.remote.remoteInventoryItemId,
  });
});

describe("SkuMatchingClient", () => {
  it("clears connectionId from the URL when the client changes", () => {
    renderClient();

    fireEvent.change(screen.getByLabelText("Client"), {
      target: { value: "55555555-5555-4555-8555-555555555555" },
    });

    expect(routerPush).toHaveBeenCalledWith("?orgId=55555555-5555-4555-8555-555555555555");
  });

  it("renders Shopify and Bandcamp comparison links", () => {
    renderClient();

    expect(screen.getByTestId("sku-matching-toaster").dataset.position).toBe("top-center");
    expect(
      (screen.getByRole("link", { name: /Open Shopify product/i }) as HTMLAnchorElement).href,
    ).toBe(candidate.remote.productUrl);
    expect(
      (screen.getByRole("link", { name: /Open Bandcamp product/i }) as HTMLAnchorElement).href,
    ).toBe("https://northernspy.bandcamp.com/album/product");
  });

  it("surfaces Accept best match failures outside the dialog", async () => {
    createOrUpdateSkuMatch.mockRejectedValueOnce(new Error("persist_failed: RPC unavailable"));
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: "Accept best match" }));

    await screen.findByText("SKU match action failed");
    expect(screen.getAllByText("persist_failed: RPC unavailable").length).toBeGreaterThan(0);
    expect(toastError).toHaveBeenCalledWith("SKU match rejected — persist_failed: RPC unavailable");
  });

  it("optimistically removes accepted rows and shows a saved toast", async () => {
    createOrUpdateSkuMatch.mockResolvedValueOnce({ success: true });
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: "Accept best match" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("SKU match saved"));
    expect(screen.queryByRole("button", { name: "Accept best match" })).toBeNull();
  });

  it("renders dense row content while below the page-local virtualization threshold", () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      ...workspace().rows[0],
      variantId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      canonicalSku: `NS-${String(index).padStart(3, "0")}`,
    }));

    renderClient(workspace({ rows, needsReviewCount: rows.length }));

    expect(screen.getByText("NS-000")).toBeTruthy();
    expect(screen.getByText("NS-249")).toBeTruthy();
  });

  it("lets staff search the remote catalog from the review drawer and confirm a selected result", async () => {
    const manualRemote = {
      ...candidate.remote,
      remoteProductId: "gid://shopify/Product/2",
      remoteVariantId: "gid://shopify/ProductVariant/2",
      remoteInventoryItemId: "gid://shopify/InventoryItem/2",
      remoteSku: "REAL-001",
      productTitle: "Correct Remote Title",
      combinedTitle: "Correct Remote Title - LP",
    };
    searchSkuRemoteCatalog.mockResolvedValueOnce({
      results: [manualRemote],
      remoteCatalogState: "ok",
      remoteCatalogError: null,
    });
    previewSkuMatch.mockResolvedValueOnce({
      canonical: {
        variantId: workspace().rows[0].variantId,
        sku: "NS-001",
        barcode: null,
        title: "Northern Spy Product",
        artist: "Northern Spy",
        format: "LP",
        bandcampTitle: "Northern Spy Product",
        bandcampUrl: "https://northernspy.bandcamp.com/album/product",
      },
      existingMapping: null,
      targetRemote: candidate.remote,
      targetError: null,
      candidate,
      fingerprint: "fingerprint-1",
      shopifyReadiness: null,
      remoteCatalogState: "ok",
      remoteCatalogError: null,
    });
    previewSkuMatch.mockResolvedValueOnce({
      canonical: {
        variantId: workspace().rows[0].variantId,
        sku: "NS-001",
        barcode: null,
        title: "Northern Spy Product",
        artist: "Northern Spy",
        format: "LP",
        bandcampTitle: "Northern Spy Product",
        bandcampUrl: "https://northernspy.bandcamp.com/album/product",
      },
      existingMapping: null,
      targetRemote: manualRemote,
      targetError: null,
      candidate: { ...candidate, remote: manualRemote, matchMethod: "manual" },
      fingerprint: "manual-fingerprint",
      shopifyReadiness: null,
      remoteCatalogState: "ok",
      remoteCatalogError: null,
    });
    createOrUpdateSkuMatch.mockResolvedValueOnce({ mapping_id: "mapping-1" });

    renderClient();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText("Search remote catalog");
    expect(screen.getByRole("dialog").className).toContain("max-h-[calc(100dvh-1rem)]");
    expect(screen.getByRole("dialog").className).toContain("overflow-x-hidden");
    fireEvent.change(screen.getByPlaceholderText(/album title/i), {
      target: { value: "Correct Remote Title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("Correct Remote Title - LP");
    fireEvent.click(screen.getByRole("button", { name: "Preview this match" }));
    await screen.findByText(/REAL-001/);
    fireEvent.click(screen.getByRole("button", { name: /Confirm match/i }));

    expect(searchSkuRemoteCatalog).toHaveBeenCalledWith({
      connectionId: connection.id,
      query: "Correct Remote Title",
      limit: 25,
    });
    await waitFor(() =>
      expect(createOrUpdateSkuMatch).toHaveBeenCalledWith(
        expect.objectContaining({
          remoteProductId: manualRemote.remoteProductId,
          remoteVariantId: manualRemote.remoteVariantId,
          remoteInventoryItemId: manualRemote.remoteInventoryItemId,
          remoteSku: manualRemote.remoteSku,
          matchMethod: "manual",
          matchConfidence: "strong",
        }),
      ),
    );
  });

  it("marks the current remote candidate as not a match from the review drawer", async () => {
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText("Search remote catalog");
    fireEvent.click(screen.getByRole("button", { name: /Not a match/i }));

    await waitFor(() =>
      expect(rejectSkuMatchCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          variantId: workspace().rows[0].variantId,
          remoteProductId: candidate.remote.remoteProductId,
          remoteVariantId: candidate.remote.remoteVariantId,
          remoteInventoryItemId: candidate.remote.remoteInventoryItemId,
          remoteSku: candidate.remote.remoteSku,
          scope: "connection",
          reason: "manual_not_match",
        }),
      ),
    );
  });
});
