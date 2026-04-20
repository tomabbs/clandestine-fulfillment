// Phase 8.5 — Edit Tags modal.
//
// Lists all SS tags (cached 1h via the v1 listTags client + 60s React Query
// cache here). User toggles which tags should be applied to the order;
// modal computes the add/remove diff against the order's current tag_ids
// and submits via editOrderTags(...).
"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  editOrderTags,
  listShipStationTagDefinitions,
} from "@/actions/shipstation-orders";
import { Button } from "@/components/ui/button";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export interface EditTagsModalProps {
  open: boolean;
  onClose: () => void;
  shipstationOrderUuid: string;
  currentTagIds: number[];
  onSaved: () => void;
}

export function CockpitEditTagsModal({
  open,
  onClose,
  shipstationOrderUuid,
  currentTagIds,
  onSaved,
}: EditTagsModalProps) {
  const [selected, setSelected] = useState<number[]>(currentTagIds);

  // Re-sync selection when the modal opens.
  useEffect(() => {
    if (open) setSelected(currentTagIds);
  }, [open, currentTagIds]);

  const tagsQuery = useAppQuery({
    queryKey: ["ss-tag-defs"],
    queryFn: () => listShipStationTagDefinitions(),
    tier: CACHE_TIERS.SESSION,
    enabled: open,
  });

  const editMut = useAppMutation({
    mutationFn: () => {
      const addIds = selected.filter((id) => !currentTagIds.includes(id));
      const removeIds = currentTagIds.filter((id) => !selected.includes(id));
      return editOrderTags({
        shipstationOrderUuid,
        addTagIds: addIds,
        removeTagIds: removeIds,
      });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const dirty = useMemo(() => {
    const a = [...selected].sort((x, y) => x - y).join(",");
    const b = [...currentTagIds].sort((x, y) => x - y).join(",");
    return a !== b;
  }, [selected, currentTagIds]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background border rounded-lg shadow-xl w-[420px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-sm">Edit Tags</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-muted rounded text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {tagsQuery.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading tags…
            </div>
          ) : (tagsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4">
              No tags configured in ShipStation.
            </p>
          ) : (
            <div className="space-y-1">
              {(tagsQuery.data ?? []).map((tag) => {
                const isOn = selected.includes(tag.tagId);
                return (
                  <label
                    key={tag.tagId}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelected([...selected, tag.tagId]);
                        } else {
                          setSelected(selected.filter((id) => id !== tag.tagId));
                        }
                      }}
                    />
                    {tag.color && (
                      <span
                        className="inline-block w-3 h-3 rounded-sm border"
                        style={{ backgroundColor: tag.color }}
                      />
                    )}
                    <span>{tag.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!dirty || editMut.isPending}
            onClick={() => editMut.mutate()}
          >
            {editMut.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
