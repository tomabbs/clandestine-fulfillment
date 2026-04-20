import { config } from "dotenv";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
config({ path: ".env.local" });

(async () => {
  const sb = createServiceRoleClient();
  const { data, error } = await sb
    .from("bandcamp_product_mappings")
    .select("*")
    .limit(2);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log("columns:", Object.keys(data?.[0] ?? {}));
  for (const r of data ?? []) {
    console.log(JSON.stringify(r, null, 2));
  }
})();
