import { tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "./supabase-server";

export async function isBundleVariant(
  variantId: string,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  if (cache?.has(variantId)) return cache.get(variantId)!;
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("bundle_components")
    .select("id")
    .eq("bundle_variant_id", variantId)
    .limit(1);
  const result = (data?.length ?? 0) > 0;
  cache?.set(variantId, result);
  return result;
}

export async function triggerBundleFanout(params: {
  variantId: string;
  soldQuantity: number;
  workspaceId: string;
  correlationBase: string;
  cache?: Map<string, boolean>;
}): Promise<{ triggered: boolean; runId?: string; error?: string }> {
  try {
    const isBundle = await isBundleVariant(params.variantId, params.cache);
    if (!isBundle) return { triggered: false };

    const handle = await tasks.trigger("bundle-component-fanout", {
      bundleVariantId: params.variantId,
      soldQuantity: params.soldQuantity,
      workspaceId: params.workspaceId,
      correlationBase: params.correlationBase,
    });

    return { triggered: true, runId: handle.id };
  } catch (err) {
    return { triggered: false, error: String(err) };
  }
}
