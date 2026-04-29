# Order Pages Transition Smoke

- Generated: 2026-04-29T17:58:27.965Z
- Routes: 5
- Passed: 5
- Failed: 0

## Route Results

- [PASS] `/admin/orders` status=200 load=276ms pageErrors=0 console=0 network=0 hydration=0 landmark=Orders
- [PASS] `/admin/orders/shipstation` status=200 load=133ms pageErrors=0 console=0 network=0 hydration=0 landmark=Orders
- [PASS] `/admin/orders/diagnostics` status=200 load=282ms pageErrors=0 console=0 network=0 hydration=0 landmark=Order Pages Transition — Diagnostics
- [PASS] `/admin/orders` status=200 load=265ms pageErrors=0 console=0 network=1 hydration=0 landmark=Direct Orders
- [PASS] `/admin/orders/4641cf52-579c-454e-914f-e9730435cd50` status=200 load=242ms pageErrors=0 console=1 network=1 hydration=0 landmark=—
  - console errors:
    - TypeError: Failed to fetch     at eval (webpack-internal:///(app-pages-browser)/./node_modules/.pnpm/@supabase+auth-js@2.99.2/node_modules/@supabase/auth-js/dist/module/lib/helpers.js:120:25)     at _handleRequest (webpack-internal:///(app-
