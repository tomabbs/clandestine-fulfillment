/**
 * Squarespace access token refresh utility.
 *
 * Checks token_expires_at in metadata and refreshes if within 5 minutes of expiry.
 * Uses token_refresh_locked_at for atomic locking to prevent concurrent refreshes
 * across multiple serverless instances. (C9 fix)
 *
 * Rule #7: Uses createServiceRoleClient().
 */

import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh if expiring within 5 minutes
const LOCK_TIMEOUT_MS = 30 * 1000; // Lock expires after 30 seconds

/**
 * Refresh the Squarespace access token for a connection if needed.
 * Returns the current (or newly refreshed) access token.
 *
 * @param connectionId - The client_store_connections.id for a Squarespace connection
 * @returns Current valid access token
 */
export async function refreshSquarespaceTokenIfNeeded(connectionId: string): Promise<string> {
  const supabase = createServiceRoleClient();

  const { data: connection } = await supabase
    .from("client_store_connections")
    .select("id, api_key, api_secret, metadata, token_refresh_locked_at, connection_status")
    .eq("id", connectionId)
    .eq("platform", "squarespace")
    .single();

  if (!connection) throw new Error(`Squarespace connection ${connectionId} not found`);
  if (!connection.api_key) throw new Error("No access token stored for connection");
  if (!connection.api_secret) throw new Error("No refresh token stored for connection");

  const meta = (connection.metadata ?? {}) as { token_expires_at?: string };
  const expiresAt = meta.token_expires_at ? new Date(meta.token_expires_at) : null;
  const now = new Date();

  // Token is still valid — return it
  if (expiresAt && expiresAt.getTime() - now.getTime() > REFRESH_BUFFER_MS) {
    return connection.api_key;
  }

  // Check if another instance is already refreshing (C9 race condition fix)
  const lockedAt = connection.token_refresh_locked_at
    ? new Date(connection.token_refresh_locked_at)
    : null;

  if (lockedAt && now.getTime() - lockedAt.getTime() < LOCK_TIMEOUT_MS) {
    // Another instance is refreshing — wait briefly and return current token
    // The other instance will update the DB; caller can retry if it still fails
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { data: updated } = await supabase
      .from("client_store_connections")
      .select("api_key")
      .eq("id", connectionId)
      .single();
    return updated?.api_key ?? connection.api_key;
  }

  // Acquire lock
  const { error: lockError } = await supabase
    .from("client_store_connections")
    .update({ token_refresh_locked_at: now.toISOString() })
    .eq("id", connectionId)
    .is("token_refresh_locked_at", null); // Only lock if not already locked

  if (lockError) {
    // Lock acquisition failed — another instance won the race
    return connection.api_key;
  }

  try {
    const tokenRes = await fetch(
      "https://login.squarespace.com/api/1/login/oauth/provider/tokens",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: connection.api_secret,
          client_id: env().SQUARESPACE_CLIENT_ID,
          client_secret: env().SQUARESPACE_CLIENT_SECRET,
        }),
      },
    );

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      // Mark connection as auth failure
      await supabase
        .from("client_store_connections")
        .update({
          connection_status: "disabled_auth_failure",
          last_error: `Token refresh failed: ${tokenRes.status} ${text}`,
          last_error_at: new Date().toISOString(),
          token_refresh_locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", connectionId);
      throw new Error(`Squarespace token refresh failed: ${tokenRes.status}`);
    }

    const { access_token, refresh_token, expires_in } = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const newExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await supabase
      .from("client_store_connections")
      .update({
        api_key: access_token,
        api_secret: refresh_token,
        metadata: { ...meta, token_expires_at: newExpiresAt },
        connection_status: "active",
        last_error: null,
        last_error_at: null,
        token_refresh_locked_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);

    return access_token;
  } catch (error) {
    // Release lock on unexpected error
    await supabase
      .from("client_store_connections")
      .update({ token_refresh_locked_at: null })
      .eq("id", connectionId);
    throw error;
  }
}
