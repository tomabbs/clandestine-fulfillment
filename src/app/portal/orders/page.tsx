import { redirect } from "next/navigation";

/**
 * Redirect /portal/orders → /portal/fulfillment
 * Maintains backward compatibility for bookmarks and saved links.
 */
export default function PortalOrdersRedirect() {
  redirect("/portal/fulfillment");
}
