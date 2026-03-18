"use client";

import { X } from "lucide-react";
import type { EditorPresence, RemoteChange } from "@/lib/hooks/use-collaborative-editing";

interface FieldEditIndicatorProps {
  fieldName: string;
  isBeingEdited: boolean;
  editor: EditorPresence | null;
  children: React.ReactNode;
}

export function FieldEditIndicator({
  fieldName: _fieldName,
  isBeingEdited,
  editor,
  children,
}: FieldEditIndicatorProps) {
  if (!isBeingEdited || !editor) {
    return <>{children}</>;
  }

  return (
    <div className="relative border-l-2 border-amber-500 pl-3">
      <span className="absolute -top-5 left-3 text-xs text-amber-600 font-medium">
        {editor.userName} is editing...
      </span>
      {children}
    </div>
  );
}

interface RemoteChangeNotificationProps {
  changes: RemoteChange[];
  onDismiss: () => void;
}

export function RemoteChangeNotification({ changes, onDismiss }: RemoteChangeNotificationProps) {
  if (changes.length === 0) return null;

  const latest = changes[changes.length - 1];

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border bg-background p-4 shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{latest.userName} saved changes</p>
          <p className="text-xs text-muted-foreground mt-1">
            Updated: {latest.savedFields.join(", ")}
          </p>
          {changes.length > 1 && (
            <p className="text-xs text-muted-foreground">
              +{changes.length - 1} more update{changes.length > 2 ? "s" : ""}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface PresenceDotsProps {
  editors: EditorPresence[];
}

export function PresenceDots({ editors }: PresenceDotsProps) {
  if (editors.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {editors.map((editor) => (
        <div key={editor.userId} className="flex items-center gap-1" title={editor.userName}>
          <span className="h-2 w-2 rounded-full bg-green-500" />
          <span className="text-xs text-muted-foreground">{editor.userName}</span>
        </div>
      ))}
    </div>
  );
}
