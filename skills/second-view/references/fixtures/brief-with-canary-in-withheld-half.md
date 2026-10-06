=== SENT TO CODEX ===
Problem statement
We need a way to cache product tile images without a CDN.

Constraints
Nuxt 3, no new infrastructure, must work in SSR.

Success criteria
Repeat page loads avoid refetching the same image bytes.

Ruled out
A third-party image CDN, because procurement takes six weeks.

=== WITHHELD ===
Current direction
Lean toward a service worker with a stale-while-revalidate policy.
WITHHELD_CANARY_7f3a
