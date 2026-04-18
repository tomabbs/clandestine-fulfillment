#!/usr/bin/env python3
"""
assign-missing-skus.py — One-off script to assign canonical SKUs to two
Shopify products that were synced with blank SKUs, creating garbage
placeholder SKUs in the database.

Products:
  - leon todd johnson - wa kei sei jaku CD  → CD-WS-WKSJ
  - Oeil - Dream Within A Dream LP          → LP-HM-DWAD

Steps performed:
  1. Update Shopify variant SKU via productVariantsBulkUpdate
  2. Update warehouse_product_variants.sku in Supabase
  3. Update warehouse_inventory_levels.sku in Supabase
  4. Update warehouse_inventory_activity.sku in Supabase (for traceability)
  5. Rename inv:{old_sku} → inv:{new_sku} in Upstash Redis

Idempotent: each step checks whether the target state already exists before
writing. Safe to re-run.
"""
import json
import os
import urllib.request
import sys

# ── Credentials ──────────────────────────────────────────────────────────────

SHOPIFY_URL   = "https://kw16ph-t9.myshopify.com"
SHOPIFY_TOKEN = os.environ["SHOPIFY_ADMIN_API_TOKEN"]
SHOPIFY_VER   = "2026-01"

SUPABASE_URL  = "https://yspmgzphxlkcnfalndbh.supabase.co"
SUPABASE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

REDIS_URL     = "https://smooth-goldfish-38578.upstash.io"
REDIS_TOKEN   = os.environ["UPSTASH_REDIS_REST_TOKEN"]

# ── SKU assignments ───────────────────────────────────────────────────────────

ASSIGNMENTS = [
    {
        "description":    "leon todd johnson - wa kei sei jaku CD",
        "product_gid":    "gid://shopify/Product/10125365575995",
        "variant_gid":    "gid://shopify/ProductVariant/50408177828155",
        "variant_id_num": "50408177828155",
        "old_sku":        "10125365575995-50408177828155",
        "new_sku":        "CD-WS-WKSJ",
    },
    {
        "description":    "Oeil - Dream Within A Dream LP",
        "product_gid":    "gid://shopify/Product/10125402014011",
        "variant_gid":    "gid://shopify/ProductVariant/50408250835259",
        "variant_id_num": "50408250835259",
        "old_sku":        "10125402014011-50408250835259",
        "new_sku":        "LP-HM-DWAD",
    },
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def shopify_gql(query, variables=None):
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        f"{SHOPIFY_URL}/admin/api/{SHOPIFY_VER}/graphql.json",
        data=payload,
        headers={
            "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def sb_patch(table, filters, body):
    """PATCH a Supabase table row. Returns (status_code, response_body)."""
    data = json.dumps(body).encode()
    url = f"{SUPABASE_URL}/rest/v1/{table}?{filters}"
    req = urllib.request.Request(
        url,
        data=data,
        method="PATCH",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def sb_select(table, filters):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{filters}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def redis_cmd(*args):
    """Call Upstash Redis REST API with the given command args."""
    payload = json.dumps(list(args)).encode()
    req = urllib.request.Request(
        REDIS_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {REDIS_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()}


# ── Main ──────────────────────────────────────────────────────────────────────

errors = []

for a in ASSIGNMENTS:
    print(f"\n{'='*60}")
    print(f"Processing: {a['description']}")
    print(f"  {a['old_sku']}  →  {a['new_sku']}")
    print(f"{'='*60}")

    # ── Step 1: Shopify variant SKU update ─────────────────────────────────
    print("\n[1/5] Shopify: productVariantsBulkUpdate")
    # Note: In Shopify API 2024-10+, `sku` is NOT a direct field on
    # ProductVariantsBulkInput. It must be set via `inventoryItem.sku`.
    mutation = """
    mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id inventoryItem { sku } }
        userErrors { field message }
      }
    }
    """
    resp = shopify_gql(mutation, {
        "productId": a["product_gid"],
        "variants": [{"id": a["variant_gid"], "inventoryItem": {"sku": a["new_sku"]}}],
    })
    result = resp.get("data", {}).get("productVariantsBulkUpdate", {})
    user_errors = result.get("userErrors", [])
    if user_errors:
        msg = f"  ERROR: {user_errors}"
        print(msg)
        errors.append(msg)
    else:
        updated = result.get("productVariants", [])
        for v in updated:
            actual_sku = v.get("inventoryItem", {}).get("sku")
            status = "OK" if actual_sku == a["new_sku"] else "MISMATCH"
            print(f"  [{status}]: variant {v['id']} SKU is now '{actual_sku}'")

    # ── Step 2: warehouse_product_variants.sku ─────────────────────────────
    print("\n[2/5] DB: warehouse_product_variants")
    existing = sb_select(
        "warehouse_product_variants",
        f"select=id,sku&sku=eq.{a['new_sku']}",
    )
    if existing:
        print(f"  SKIP: new SKU already exists (id={existing[0]['id']})")
    else:
        status, body = sb_patch(
            "warehouse_product_variants",
            f"sku=eq.{a['old_sku']}",
            {"sku": a["new_sku"]},
        )
        if status in (200, 201, 204):
            count = len(body) if isinstance(body, list) else "?"
            print(f"  OK: updated {count} row(s) (HTTP {status})")
        else:
            msg = f"  ERROR HTTP {status}: {body}"
            print(msg)
            errors.append(msg)

    # ── Step 3: warehouse_inventory_levels.sku ─────────────────────────────
    print("\n[3/5] DB: warehouse_inventory_levels")
    inv_existing = sb_select(
        "warehouse_inventory_levels",
        f"select=id,sku&sku=eq.{a['new_sku']}",
    )
    if inv_existing:
        print(f"  SKIP: new SKU already exists (id={inv_existing[0]['id']})")
    else:
        # Check if old SKU row exists
        inv_old = sb_select(
            "warehouse_inventory_levels",
            f"select=id,sku&sku=eq.{a['old_sku']}",
        )
        if not inv_old:
            print(f"  NOTE: no inventory_levels row for old SKU '{a['old_sku']}' (may be NO_ROW case — OK)")
        else:
            status, body = sb_patch(
                "warehouse_inventory_levels",
                f"sku=eq.{a['old_sku']}",
                {"sku": a["new_sku"]},
            )
            if status in (200, 201, 204):
                count = len(body) if isinstance(body, list) else "?"
                print(f"  OK: updated {count} row(s) (HTTP {status})")
            else:
                msg = f"  ERROR HTTP {status}: {body}"
                print(msg)
                errors.append(msg)

    # ── Step 4: warehouse_inventory_activity.sku ───────────────────────────
    print("\n[4/5] DB: warehouse_inventory_activity")
    act_old = sb_select(
        "warehouse_inventory_activity",
        f"select=id&sku=eq.{a['old_sku']}&limit=1",
    )
    if not act_old:
        print(f"  NOTE: no activity rows for old SKU '{a['old_sku']}' — nothing to rename")
    else:
        status, body = sb_patch(
            "warehouse_inventory_activity",
            f"sku=eq.{a['old_sku']}",
            {"sku": a["new_sku"]},
        )
        if status in (200, 201, 204):
            count = len(body) if isinstance(body, list) else "?"
            print(f"  OK: updated {count} activity row(s) (HTTP {status})")
        else:
            msg = f"  ERROR HTTP {status}: {body}"
            print(msg)
            errors.append(msg)

    # ── Step 5: Redis RENAME ───────────────────────────────────────────────
    print("\n[5/5] Redis: RENAME inv key")
    old_key = f"inv:{a['old_sku']}"
    new_key = f"inv:{a['new_sku']}"

    # Check if old key exists
    exists_resp = redis_cmd("EXISTS", old_key)
    key_exists = exists_resp.get("result", 0)
    if not key_exists:
        print(f"  NOTE: Redis key '{old_key}' does not exist — nothing to rename (OK for low-traffic SKU)")
    else:
        rename_resp = redis_cmd("RENAME", old_key, new_key)
        if rename_resp.get("result") == "OK":
            print(f"  OK: renamed '{old_key}' → '{new_key}'")
        else:
            msg = f"  ERROR: {rename_resp}"
            print(msg)
            errors.append(msg)

print(f"\n{'='*60}")
if errors:
    print(f"COMPLETED WITH {len(errors)} ERROR(S):")
    for e in errors:
        print(f"  {e}")
    sys.exit(1)
else:
    print("ALL STEPS COMPLETED SUCCESSFULLY")
