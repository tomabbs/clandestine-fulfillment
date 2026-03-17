"use client";

import { Calendar, Disc3, Loader2, Package } from "lucide-react";
import Image from "next/image";
import { getClientReleases } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ReleaseVariant = {
  id: string;
  sku: string;
  title: string | null;
  street_date: string | null;
  is_preorder: boolean;
  warehouse_products: {
    id: string;
    title: string;
    status: string;
    org_id: string;
    warehouse_product_images: Array<{
      id: string;
      src: string;
      alt: string | null;
      position: number;
    }>;
  };
  warehouse_inventory_levels: Array<{
    available: number;
    committed: number;
    incoming: number;
  }>;
};

export default function ReleasesPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clientReleases.list(),
    queryFn: () => getClientReleases(),
    tier: CACHE_TIERS.SESSION,
  });

  const preorders = (data?.preorders ?? []) as unknown as ReleaseVariant[];
  const newReleases = (data?.newReleases ?? []) as unknown as ReleaseVariant[];

  if (isLoading) {
    return (
      <div className="p-6 flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Releases</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" /> Upcoming Pre-Orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{preorders.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Disc3 className="h-3.5 w-3.5" /> Recent Releases (30d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{newReleases.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Pre-orders section */}
      <div className="space-y-2">
        <h2 className="text-lg font-medium">Upcoming Pre-Orders</h2>
        {preorders.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4">No upcoming pre-orders.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" />
                <TableHead>Title</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Street Date</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Incoming</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preorders.map((v) => {
                const product = v.warehouse_products;
                const images = product?.warehouse_product_images ?? [];
                const primaryImage = images.sort((a, b) => a.position - b.position)[0];
                const inv = v.warehouse_inventory_levels?.[0];

                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      {primaryImage ? (
                        <Image
                          src={primaryImage.src}
                          alt={primaryImage.alt ?? product.title}
                          width={32}
                          height={32}
                          className="h-8 w-8 rounded object-cover"
                        />
                      ) : (
                        <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                          <Package className="text-muted-foreground h-4 w-4" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{product?.title ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {v.sku}
                    </TableCell>
                    <TableCell>
                      {v.street_date ? (
                        <Badge variant="secondary">
                          {new Date(v.street_date).toLocaleDateString()}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">TBD</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">{inv?.committed ?? 0}</TableCell>
                    <TableCell className="text-right font-mono">{inv?.incoming ?? 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Recent releases section */}
      <div className="space-y-2">
        <h2 className="text-lg font-medium">Recent Releases</h2>
        {newReleases.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4">No releases in the past 30 days.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" />
                <TableHead>Title</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Release Date</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Committed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newReleases.map((v) => {
                const product = v.warehouse_products;
                const images = product?.warehouse_product_images ?? [];
                const primaryImage = images.sort((a, b) => a.position - b.position)[0];
                const inv = v.warehouse_inventory_levels?.[0];

                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      {primaryImage ? (
                        <Image
                          src={primaryImage.src}
                          alt={primaryImage.alt ?? product.title}
                          width={32}
                          height={32}
                          className="h-8 w-8 rounded object-cover"
                        />
                      ) : (
                        <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                          <Package className="text-muted-foreground h-4 w-4" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{product?.title ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {v.sku}
                    </TableCell>
                    <TableCell>
                      {v.street_date ? (
                        <span className="text-sm">
                          {new Date(v.street_date).toLocaleDateString()}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">{inv?.available ?? 0}</TableCell>
                    <TableCell className="text-right font-mono">{inv?.committed ?? 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
