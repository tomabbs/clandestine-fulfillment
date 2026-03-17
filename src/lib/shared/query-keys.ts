export const queryKeys = {
  products: {
    all: ["products"] as const,
    list: (filters?: Record<string, unknown>) => ["products", "list", filters] as const,
    detail: (id: string) => ["products", "detail", id] as const,
  },
  inventory: {
    all: ["inventory"] as const,
    list: (filters?: Record<string, unknown>) => ["inventory", "list", filters] as const,
    detail: (sku: string) => ["inventory", "detail", sku] as const,
  },
  orders: {
    all: ["orders"] as const,
    list: (filters?: Record<string, unknown>) => ["orders", "list", filters] as const,
    detail: (id: string) => ["orders", "detail", id] as const,
  },
  shipments: {
    all: ["shipments"] as const,
    list: (filters?: Record<string, unknown>) => ["shipments", "list", filters] as const,
    detail: (id: string) => ["shipments", "detail", id] as const,
  },
  inbound: {
    all: ["inbound"] as const,
    list: (filters?: Record<string, unknown>) => ["inbound", "list", filters] as const,
    detail: (id: string) => ["inbound", "detail", id] as const,
  },
  billing: {
    all: ["billing"] as const,
    rules: () => ["billing", "rules"] as const,
    snapshots: (filters?: Record<string, unknown>) => ["billing", "snapshots", filters] as const,
  },
  support: {
    all: ["support"] as const,
    conversations: (filters?: Record<string, unknown>) =>
      ["support", "conversations", filters] as const,
    messages: (conversationId: string) => ["support", "messages", conversationId] as const,
  },
  channels: {
    all: ["channels"] as const,
    syncStatus: () => ["channels", "sync-status"] as const,
  },
  reviewQueue: {
    all: ["review-queue"] as const,
    list: (filters?: Record<string, unknown>) => ["review-queue", "list", filters] as const,
  },
  clients: {
    all: ["clients"] as const,
    list: () => ["clients", "list"] as const,
    detail: (id: string) => ["clients", "detail", id] as const,
  },
  storeConnections: {
    all: ["store-connections"] as const,
    list: (orgId?: string) => ["store-connections", "list", orgId] as const,
  },
  pirateShipImports: {
    all: ["pirate-ship-imports"] as const,
    list: (filters?: Record<string, unknown>) => ["pirate-ship-imports", "list", filters] as const,
    detail: (id: string) => ["pirate-ship-imports", "detail", id] as const,
  },
  bandcamp: {
    all: ["bandcamp"] as const,
    accounts: (workspaceId: string) => ["bandcamp", "accounts", workspaceId] as const,
    mappings: (orgId: string) => ["bandcamp", "mappings", orgId] as const,
  },
  storeMappings: {
    all: ["store-mappings"] as const,
    list: (workspaceId: string) => ["store-mappings", "list", workspaceId] as const,
  },
  catalog: {
    all: ["catalog"] as const,
    list: (filters?: Record<string, unknown>) => ["catalog", "list", filters] as const,
  },
  clientReleases: {
    all: ["client-releases"] as const,
    list: () => ["client-releases", "list"] as const,
  },
} as const;
