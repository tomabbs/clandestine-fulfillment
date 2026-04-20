// Phase 8.3 — Saved Views dropdown for the cockpit.
//
// "View" = a snapshot of the cockpit's filter+sort state. Save under a name;
// load with one click; mark as default (loaded automatically on first render).
//
// Surface key for the orders cockpit: "orders_cockpit".
"use client";

import { Star, StarOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  deleteView,
  listViews,
  type SavedView,
  saveView,
  setDefaultView,
} from "@/actions/user-views";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const SURFACE = "orders_cockpit";
const VIEW_STATE_VERSION = 1;

interface PersistedViewEnvelope extends Record<string, unknown> {
  version: number;
  surface: string;
  queryState: Record<string, unknown>;
  blockPrefs?: Record<string, unknown>;
}

interface CockpitSavedViewsProps {
  /** Current filter snapshot (will be saved if user clicks Save). */
  currentViewState: Record<string, unknown>;
  /** Apply a loaded view's state. */
  onLoadView: (state: Record<string, unknown>) => void;
  /** URL params should override default saved views on first load. */
  skipDefaultLoad?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeViewState(state: Record<string, unknown>): PersistedViewEnvelope {
  return {
    version: VIEW_STATE_VERSION,
    surface: SURFACE,
    queryState: state,
    blockPrefs: {},
  };
}

function deserializeViewState(raw: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(raw.queryState)) {
    return raw.queryState;
  }
  return raw;
}

export function CockpitSavedViews({
  currentViewState,
  onLoadView,
  skipDefaultLoad = false,
}: CockpitSavedViewsProps) {
  const [showSave, setShowSave] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIsDefault, setNewIsDefault] = useState(false);

  const viewsQuery = useAppQuery({
    queryKey: ["user-views", SURFACE],
    queryFn: () => listViews({ surface: SURFACE }),
    tier: CACHE_TIERS.SESSION,
  });

  const saveMut = useAppMutation({
    mutationFn: () =>
      saveView({
        surface: SURFACE,
        name: newName.trim(),
        view_state: serializeViewState(currentViewState),
        is_default: newIsDefault,
      }),
    onSuccess: () => {
      setShowSave(false);
      setNewName("");
      setNewIsDefault(false);
      viewsQuery.refetch();
    },
  });

  const deleteMut = useAppMutation({
    mutationFn: (id: string) => deleteView({ id }),
    onSuccess: () => viewsQuery.refetch(),
  });

  const setDefaultMut = useAppMutation({
    mutationFn: (id: string) => setDefaultView({ id, surface: SURFACE }),
    onSuccess: () => viewsQuery.refetch(),
  });

  // Auto-load the default view ONCE on first mount (never on subsequent renders).
  const [defaultLoaded, setDefaultLoaded] = useState(false);
  useEffect(() => {
    if (defaultLoaded) return;
    if (skipDefaultLoad) {
      setDefaultLoaded(true);
      return;
    }
    const def = (viewsQuery.data ?? []).find((v) => v.is_default);
    if (def) {
      onLoadView(deserializeViewState(def.view_state));
    }
    if (viewsQuery.data) setDefaultLoaded(true);
  }, [viewsQuery.data, defaultLoaded, onLoadView, skipDefaultLoad]);

  const views: SavedView[] = viewsQuery.data ?? [];

  return (
    <div className="flex items-center gap-2">
      <Select
        value=""
        onValueChange={(v) => {
          if (!v) return;
          const view = views.find((x) => x.id === v);
          if (view) onLoadView(deserializeViewState(view.view_state));
        }}
      >
        <SelectTrigger className="w-56">
          <SelectValue placeholder={`Saved views (${views.length})`} />
        </SelectTrigger>
        <SelectContent>
          {views.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</div>
          ) : (
            views.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                <span className="flex items-center gap-1.5">
                  {v.is_default && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                  {v.name}
                </span>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>

      {showSave ? (
        <div className="flex items-center gap-1.5">
          <Input
            placeholder="View name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-9 w-44"
            autoFocus
          />
          <label className="text-xs flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={newIsDefault}
              onChange={(e) => setNewIsDefault(e.target.checked)}
            />
            Default
          </label>
          <Button
            size="sm"
            onClick={() => saveMut.mutate()}
            disabled={!newName.trim() || saveMut.isPending}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowSave(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setShowSave(true)}>
          + Save view
        </Button>
      )}

      {views.length > 0 && (
        <details className="relative">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none px-2 py-1">
            Manage
          </summary>
          <div className="absolute right-0 top-full mt-1 z-10 w-72 bg-background border rounded-md shadow-md p-2 space-y-1">
            {views.map((v) => (
              <div key={v.id} className="flex items-center justify-between gap-2 text-sm py-1">
                <span className="truncate">{v.name}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDefaultMut.mutate(v.id)}
                    className="p-1 hover:bg-muted rounded"
                    title={v.is_default ? "Default" : "Set as default"}
                  >
                    {v.is_default ? (
                      <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                    ) : (
                      <StarOff className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteMut.mutate(v.id)}
                    className="p-1 hover:bg-muted rounded text-destructive"
                    title="Delete view"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
