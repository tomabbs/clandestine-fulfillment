"use client";

import { Loader2, Plus, Search, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient, getClients } from "@/actions/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function ClientsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", slug: "", billingEmail: "" });

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.list(),
    queryFn: () => getClients({ search: search || undefined }),
    tier: CACHE_TIERS.SESSION,
  });

  const createMut = useAppMutation({
    mutationFn: () => createClient(newClient),
    invalidateKeys: [queryKeys.clients.all],
    onSuccess: () => {
      setShowNew(false);
      setNewClient({ name: "", slug: "", billingEmail: "" });
    },
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Client
        </Button>
      </div>

      <div className="relative w-64">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead className="text-right">Products</TableHead>
              <TableHead className="text-right">Connections</TableHead>
              <TableHead>Onboarding</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.clients ?? []).map((client) => (
              <TableRow
                key={client.id}
                className="cursor-pointer"
                onClick={() => router.push(`/admin/clients/${client.id}`)}
              >
                <TableCell className="font-medium">{client.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {client.slug}
                </TableCell>
                <TableCell className="text-right">{client.productCount}</TableCell>
                <TableCell className="text-right">{client.activeConnections}</TableCell>
                <TableCell>
                  <OnboardingBadge pct={client.onboardingPct} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {new Date(client.createdAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {(data?.clients ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No clients found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Client</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <Input
              placeholder="Organization name"
              value={newClient.name}
              onChange={(e) =>
                setNewClient((c) => ({
                  ...c,
                  name: e.target.value,
                  slug: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                }))
              }
            />
            <Input
              placeholder="Slug"
              value={newClient.slug}
              onChange={(e) => setNewClient((c) => ({ ...c, slug: e.target.value }))}
              className="font-mono"
            />
            <Input
              type="email"
              placeholder="Billing email (optional)"
              value={newClient.billingEmail}
              onChange={(e) => setNewClient((c) => ({ ...c, billingEmail: e.target.value }))}
            />
            <Button
              className="w-full"
              disabled={!newClient.name || !newClient.slug || createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              {createMut.isPending ? "Creating..." : "Create Client"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OnboardingBadge({ pct }: { pct: number }) {
  if (pct === 100) return <Badge variant="default">Complete</Badge>;
  if (pct > 0) return <Badge variant="secondary">{pct}%</Badge>;
  return <Badge variant="outline">Not started</Badge>;
}
