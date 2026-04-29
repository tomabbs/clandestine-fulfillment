# Order Pages Transition Smoke

- Generated: 2026-04-29T17:57:50.531Z
- Routes: 5
- Passed: 5
- Failed: 0

## Route Results

- [PASS] `/admin/orders` status=200 load=2670ms pageErrors=0 console=0 network=0 hydration=0 landmark=Orders
- [PASS] `/admin/orders/shipstation` status=200 load=1157ms pageErrors=0 console=0 network=0 hydration=0 landmark=Orders
- [PASS] `/admin/orders/diagnostics` status=200 load=475ms pageErrors=0 console=0 network=0 hydration=0 landmark=Order Pages Transition — Diagnostics
- [PASS] `/admin/orders` status=200 load=214ms pageErrors=0 console=0 network=0 hydration=0 landmark=Direct Orders
- [PASS] `/admin/orders/4641cf52-579c-454e-914f-e9730435cd50` status=200 load=1452ms pageErrors=0 console=1 network=0 hydration=0 landmark=—
  - console errors:
    - Warning: Encountered two children with the same key, `%s`. Keys should be unique so that components maintain their identity across updates. Non-unique keys may cause children to be duplicated and/or omitted — the behavior is unsupported and
