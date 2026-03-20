# project_state

Living project state for architecture-safe planning and implementation.

## Files

- `engineering_map.yaml`: Component/domain inventory and ownership.
- `journeys.yaml`: Critical user/system journeys with current health and known risks.

## Update Rules

- Update these files in the same session as related code changes.
- If behavior changes but state files are not updated, mark the session `BLOCKED`.

## Minimum Session Check

Before implementation:

1. Read `TRUTH_LAYER.md`
2. Read `engineering_map.yaml`
3. Read `journeys.yaml`
4. Read `docs/system_map/INDEX.md`

After implementation:

1. Confirm impacted domains/journeys were updated.
2. Confirm API and Trigger catalogs were updated when applicable.
