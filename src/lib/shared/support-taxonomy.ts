import { z } from "zod";

export const SUPPORT_SOURCE_CHANNELS = [
  "app",
  "email",
  "discogs",
  "bandcamp_fan",
  "system",
] as const;
export const SUPPORT_DELIVERY_CHANNELS = ["app", "email", "discogs", "bandcamp", "system"] as const;
export const SUPPORT_CATEGORIES = [
  "order",
  "shipping_address",
  "inventory_sku",
  "inbound",
  "billing",
  "store_connection",
  "bandcamp_fan",
  "discogs_buyer",
  "technical_issue",
  "other",
] as const;
export const SUPPORT_RESOLUTION_CODES = [
  "answered",
  "fixed",
  "duplicate",
  "not_actionable",
  "external",
  "client_no_response",
  "spam_or_noise",
] as const;
export const SUPPORT_EVENT_TYPES = [
  "conversation_created",
  "message_created",
  "assignment_changed",
  "priority_changed",
  "category_changed",
  "tags_changed",
  "status_changed",
  "snoozed",
  "reopened",
  "resolved",
  "internal_note_created",
  "delivery_queued",
  "delivery_sent",
  "delivery_failed",
  "sla_breached",
  "collision_detected",
  "duplicate_candidate_created",
] as const;
export const SAVED_REPLY_VARIABLES = [
  "customer_name",
  "org_name",
  "agent_name",
  "order_number",
  "tracking_number",
  "shipment_status",
] as const;

export const supportSourceChannelSchema = z.enum(SUPPORT_SOURCE_CHANNELS);
export const supportCategorySchema = z.enum(SUPPORT_CATEGORIES);
export const supportResolutionCodeSchema = z.enum(SUPPORT_RESOLUTION_CODES);

export type SupportSourceChannel = (typeof SUPPORT_SOURCE_CHANNELS)[number];
export type SupportDeliveryChannel = (typeof SUPPORT_DELIVERY_CHANNELS)[number];
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportResolutionCode = (typeof SUPPORT_RESOLUTION_CODES)[number];
export type SupportEventType = (typeof SUPPORT_EVENT_TYPES)[number];
export type SavedReplyVariable = (typeof SAVED_REPLY_VARIABLES)[number];

export function interpolateSavedReply(
  template: string,
  values: Partial<Record<SavedReplyVariable, string | null | undefined>>,
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => {
    if (!SAVED_REPLY_VARIABLES.includes(key as SavedReplyVariable)) {
      return match;
    }
    return values[key as SavedReplyVariable]?.trim() ?? "";
  });
}

export function supportStatusLabel(status: string): string {
  switch (status) {
    case "waiting_on_staff":
      return "Needs staff reply";
    case "waiting_on_client":
      return "Waiting on client";
    case "resolved":
      return "Resolved";
    case "closed":
      return "Closed";
    default:
      return "Open";
  }
}

export function clientSupportStatusLabel(status: string): string {
  switch (status) {
    case "waiting_on_staff":
      return "Support is reviewing";
    case "waiting_on_client":
      return "We replied";
    case "resolved":
      return "Resolved";
    case "closed":
      return "Closed";
    default:
      return "Open";
  }
}
