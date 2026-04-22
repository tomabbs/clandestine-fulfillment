-- Shopify webhook stabilization observability queries
-- Scope: first-party `/api/webhooks/shopify` ingress + processor statuses

-- 1) Status distribution by day for inventory webhook traffic
select
  date_trunc('day', created_at) as day,
  status,
  count(*) as event_count
from webhook_events
where platform = 'shopify'
  and topic = 'inventory_levels/update'
  and created_at >= now() - interval '14 days'
group by 1, 2
order by 1 desc, 2;

-- 2) Workspace attribution quality
select
  count(*) as total_events,
  count(*) filter (where workspace_id is null) as workspace_null_count,
  round(
    100.0 * count(*) filter (where workspace_id is null) / nullif(count(*), 0),
    2
  ) as workspace_null_pct
from webhook_events
where platform = 'shopify'
  and topic = 'inventory_levels/update'
  and created_at >= now() - interval '14 days';

-- 3) Resolver trace reasons (ingress)
select
  coalesce(metadata->'resolver_trace'->>'reason', 'none') as resolver_reason,
  count(*) as event_count
from webhook_events
where platform = 'shopify'
  and topic = 'inventory_levels/update'
  and created_at >= now() - interval '14 days'
group by 1
order by 2 desc;

-- 4) Expected observe-only status rate under ShipStation-authoritative model
select
  status,
  count(*) as event_count
from webhook_events
where platform = 'shopify'
  and topic in ('inventory_levels/update', 'orders/create', 'orders/updated')
  and created_at >= now() - interval '14 days'
group by status
order by event_count desc;

-- 5) In-workspace residual mapping defects (for replay/future re-enable)
select
  status,
  count(*) as event_count
from webhook_events
where platform = 'shopify'
  and topic = 'inventory_levels/update'
  and status in (
    'inventory_item_unmapped_in_workspace',
    'variant_found_but_inventory_level_missing',
    'sku_not_found_in_workspace'
  )
  and created_at >= now() - interval '14 days'
group by status
order by event_count desc;
