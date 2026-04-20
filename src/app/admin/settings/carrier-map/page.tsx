// Phase 8 — Carrier-map admin page.
//
// At /admin/settings/carrier-map. Operator surface for the writeback
// gate: lists the EP→SS carrier mapping rows, surfaces block_auto_writeback
// + confidence, lets staff flip the block after a real round-trip test
// (which also stamps mapping_confidence='verified' + last_verified_at).
//
// "Re-seed from ShipStation" button calls listCarriers() and inserts heuristic
// rows for any carriers we don't have yet (block_auto_writeback=true).

"use client";

import { CheckCircle2, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  type CarrierMapAdminRow,
  deleteCarrierMapRow,
  listCarrierMap,
  seedCarrierMap,
  setCarrierMapBlock,
  upsertCarrierMapRow,
} from "@/actions/carrier-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const CONFIDENCE_BADGE: Record<string, { className: string; label: string }> = {
  verified: { className: "bg-emerald-100 text-emerald-800", label: "verified" },
  inferred: { className: "bg-blue-100 text-blue-800", label: "inferred" },
  manual: { className: "bg-purple-100 text-purple-800", label: "manual" },
  untested: { className: "bg-gray-100 text-gray-700", label: "untested" },
};

export default function CarrierMapAdminPage() {
  const [adding, setAdding] = useState(false);

  const { data, isLoading, refetch } = useAppQuery({
    queryKey: ["carrier-map-admin"],
    queryFn: () => listCarrierMap(),
    tier: CACHE_TIERS.SESSION,
  });

  const seedMut = useAppMutation({
    mutationFn: () => seedCarrierMap(),
    onSuccess: () => refetch(),
  });

  const rows = data?.rows ?? [];
  const ssCodes = data?.ssCarrierCodes ?? [];

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">ShipStation carrier mapping</h1>
          <p className="text-muted-foreground mt-1 text-sm max-w-2xl">
            EasyPost returns carrier names like <code>USPS</code> / <code>UPS</code> /{" "}
            <code>FedExDefault</code>. ShipStation expects account-specific codes like{" "}
            <code>stamps_com</code> / <code>ups_walleted</code>. The writeback task in
            Phase 4.3 looks up these mappings before calling SS — rows with{" "}
            <code>block_auto_writeback = true</code> refuse to write back until staff
            verifies the mapping with a real round-trip test.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() => seedMut.mutate()}
            disabled={seedMut.isPending}
          >
            {seedMut.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            Re-seed from SS
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add row
          </Button>
        </div>
      </div>

      {seedMut.data && (
        <p className="text-sm text-muted-foreground">
          Seed complete: {seedMut.data.inserted} new row(s),{" "}
          {seedMut.data.alreadyPresent} already present, {seedMut.data.total_ss_carriers}{" "}
          carriers in ShipStation account.
        </p>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading carrier map…
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>EasyPost carrier</TableHead>
                <TableHead>EP service</TableHead>
                <TableHead>SS carrier code</TableHead>
                <TableHead>SS service code</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Auto-writeback</TableHead>
                <TableHead>Last verified</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    No carrier-map rows yet. Click <strong>Re-seed from SS</strong> to populate.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <CarrierMapRow key={row.id} row={row} ssCodes={ssCodes} onChanged={refetch} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {adding && (
        <AddRowOverlay
          ssCodes={ssCodes}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

function CarrierMapRow({
  row,
  ssCodes,
  onChanged,
}: {
  row: CarrierMapAdminRow;
  ssCodes: string[];
  onChanged: () => void;
}) {
  const flipMut = useAppMutation({
    mutationFn: (args: { blockAutoWriteback: boolean; markVerified: boolean }) =>
      setCarrierMapBlock({
        rowId: row.id,
        blockAutoWriteback: args.blockAutoWriteback,
        markVerified: args.markVerified,
      }),
    onSuccess: () => onChanged(),
  });
  const deleteMut = useAppMutation({
    mutationFn: () => deleteCarrierMapRow({ rowId: row.id }),
    onSuccess: () => onChanged(),
  });

  const conf = CONFIDENCE_BADGE[row.mapping_confidence] ?? CONFIDENCE_BADGE.untested;
  const isKnownSsCode = ssCodes.length === 0 || ssCodes.includes(row.shipstation_carrier_code);

  return (
    <TableRow>
      <TableCell className="font-medium">{row.easypost_carrier}</TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {row.easypost_service ?? <span className="italic">(family wildcard)</span>}
      </TableCell>
      <TableCell className="font-mono text-sm">
        {row.shipstation_carrier_code}
        {!isKnownSsCode && (
          <span
            className="ml-1 text-amber-600 text-xs"
            title="This SS carrier code is not in the listCarriers() response — may not be connected on the SS account"
          >
            ⚠
          </span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {row.shipstation_service_code ?? "—"}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={conf?.className}>
          {conf?.label}
        </Badge>
      </TableCell>
      <TableCell>
        {row.block_auto_writeback ? (
          <Badge variant="outline" className="bg-amber-50 text-amber-800">
            blocked
          </Badge>
        ) : (
          <Badge variant="outline" className="bg-emerald-50 text-emerald-800">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            allowed
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.last_verified_at
          ? new Date(row.last_verified_at).toLocaleDateString()
          : "—"}
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex gap-1.5">
          {row.block_auto_writeback ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => flipMut.mutate({ blockAutoWriteback: false, markVerified: true })}
              disabled={flipMut.isPending}
            >
              {flipMut.isPending ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : null}
              Verify + allow
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => flipMut.mutate({ blockAutoWriteback: true, markVerified: false })}
            >
              Block
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`Delete mapping for ${row.easypost_carrier} → ${row.shipstation_carrier_code}?`)) {
                deleteMut.mutate();
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function AddRowOverlay({
  ssCodes,
  onClose,
  onSaved,
}: {
  ssCodes: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [epCarrier, setEpCarrier] = useState("");
  const [epService, setEpService] = useState(""); // empty = family wildcard
  const [ssCarrierCode, setSsCarrierCode] = useState(ssCodes[0] ?? "");
  const [ssServiceCode, setSsServiceCode] = useState("");
  const [notes, setNotes] = useState("");

  const saveMut = useAppMutation({
    mutationFn: () =>
      upsertCarrierMapRow({
        easypostCarrier: epCarrier.trim(),
        easypostService: epService.trim() || null,
        shipstationCarrierCode: ssCarrierCode.trim(),
        shipstationServiceCode: ssServiceCode.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background border rounded-lg shadow-xl w-[480px]">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm">Add carrier mapping</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-3 text-sm">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">EP carrier *</span>
            <Input
              value={epCarrier}
              onChange={(e) => setEpCarrier(e.target.value)}
              placeholder="USPS"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">EP service (blank = wildcard)</span>
            <Input
              value={epService}
              onChange={(e) => setEpService(e.target.value)}
              placeholder="Priority"
            />
          </label>
          <label className="space-y-1 col-span-2">
            <span className="text-xs text-muted-foreground">SS carrier code *</span>
            {ssCodes.length > 0 ? (
              <Select value={ssCarrierCode} onValueChange={(v) => v && setSsCarrierCode(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ssCodes.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={ssCarrierCode}
                onChange={(e) => setSsCarrierCode(e.target.value)}
                placeholder="stamps_com"
              />
            )}
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">SS service code (optional)</span>
            <Input
              value={ssServiceCode}
              onChange={(e) => setSsServiceCode(e.target.value)}
              placeholder=""
            />
          </label>
          <label className="space-y-1 col-span-2">
            <span className="text-xs text-muted-foreground">Notes</span>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Verified via shipment se-12345 on 2026-04-19"
            />
          </label>
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!epCarrier.trim() || !ssCarrierCode.trim() || saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            {saveMut.isPending ? (
              <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
            ) : null}
            Add row
          </Button>
        </div>
      </div>
    </div>
  );
}
