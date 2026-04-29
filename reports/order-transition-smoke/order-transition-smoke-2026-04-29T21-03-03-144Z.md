# Order Pages Transition Smoke

- Generated: 2026-04-29T21:03:03.145Z
- Routes: 5
- Passed: 5
- Failed: 0

## Route Results

- [PASS] `/admin/orders` status=200 load=5450ms pageErrors=0 console=0 network=0 hydration=0 landmark=Direct Orders
- [PASS] `/admin/orders/shipstation` status=200 load=658ms pageErrors=0 console=0 network=0 hydration=0 landmark=Orders
- [PASS] `/admin/orders/diagnostics` status=200 load=1274ms pageErrors=0 console=0 network=1 hydration=0 landmark=Order Pages Transition — Diagnostics
- [PASS] `/admin/orders` status=200 load=167ms pageErrors=0 console=0 network=0 hydration=0 landmark=Direct Orders
- [PASS] `/admin/orders/b11cbbec-da80-4a9a-9be3-126efeb6bac1` status=200 load=1359ms pageErrors=0 console=1 network=0 hydration=0 landmark=—
  - console errors:
    - Warning: Encountered two children with the same key, `%s`. Keys should be unique so that components maintain their identity across updates. Non-unique keys may cause children to be duplicated and/or omitted — the behavior is unsupported and
