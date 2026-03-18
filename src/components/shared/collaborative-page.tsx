"use client";

import { createContext, useContext, useMemo } from "react";
import { getUserContext } from "@/actions/auth";
import {
  FieldEditIndicator,
  PresenceDots,
  RemoteChangeNotification,
} from "@/components/shared/collaborative-editing";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import {
  type EditorPresence,
  useCollaborativeEditing,
} from "@/lib/hooks/use-collaborative-editing";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

interface CollabContextValue {
  activeEditors: EditorPresence[];
  startEditing: (fieldName: string) => Promise<void>;
  stopEditing: () => Promise<void>;
  isFieldBeingEdited: (fieldName: string) => boolean;
  getFieldEditor: (fieldName: string) => EditorPresence | null;
  broadcastSave: (savedFields: string[]) => Promise<void>;
}

const CollabContext = createContext<CollabContextValue | null>(null);

export function useCollab() {
  return useContext(CollabContext);
}

interface CollaborativePageProps {
  resourceType: string;
  resourceId: string;
  children: React.ReactNode;
}

/**
 * Wraps a page with collaborative editing support.
 * Provides presence tracking, field-level indicators, and save broadcasts.
 *
 * Usage:
 *   <CollaborativePage resourceType="product" resourceId={productId}>
 *     <PresenceBar />
 *     ... page content ...
 *   </CollaborativePage>
 */
export function CollaborativePage({ resourceType, resourceId, children }: CollaborativePageProps) {
  const { data: ctx } = useAppQuery({
    queryKey: ["user-context-collab"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });

  if (!ctx) return <>{children}</>;

  return (
    <CollaborativePageInner
      resourceType={resourceType}
      resourceId={resourceId}
      userId={ctx.userId}
      userName={ctx.userName}
    >
      {children}
    </CollaborativePageInner>
  );
}

function CollaborativePageInner({
  resourceType,
  resourceId,
  userId,
  userName,
  children,
}: CollaborativePageProps & { userId: string; userName: string }) {
  const collab = useCollaborativeEditing({ resourceType, resourceId, userId, userName });

  const value = useMemo(
    () => ({
      activeEditors: collab.activeEditors,
      startEditing: collab.startEditing,
      stopEditing: collab.stopEditing,
      isFieldBeingEdited: collab.isFieldBeingEdited,
      getFieldEditor: collab.getFieldEditor,
      broadcastSave: collab.broadcastSave,
    }),
    [collab],
  );

  return (
    <CollabContext.Provider value={value}>
      {children}
      <RemoteChangeNotification changes={collab.remoteChanges} onDismiss={collab.dismissChanges} />
    </CollabContext.Provider>
  );
}

/**
 * Shows presence dots for the current collaborative session.
 * Place near the page title.
 */
export function PresenceBar() {
  const collab = useCollab();
  if (!collab || collab.activeEditors.length === 0) return null;
  return <PresenceDots editors={collab.activeEditors} />;
}

/**
 * Wraps a form field with collaborative editing indicators.
 * Shows who is editing the field when another user focuses it.
 */
export function CollabField({ name, children }: { name: string; children: React.ReactNode }) {
  const collab = useCollab();
  if (!collab) return <>{children}</>;

  return (
    <FieldEditIndicator
      fieldName={name}
      isBeingEdited={collab.isFieldBeingEdited(name)}
      editor={collab.getFieldEditor(name)}
    >
      {children}
    </FieldEditIndicator>
  );
}
