# Search cues (Vue, Nuxt, Pinia, Apollo)

Read this file only when `package.json` lists `vue` or `nuxt`. These are places to look, not
findings.

## Error results and rejected promises

- Apollo `errorPolicy`: check the client defaults for `query`, `mutate` and `watchQuery`
  separately. A lazy or watched query with no policy set gets Apollo's default, and its error path
  may skip the result callback.
- With `errorPolicy: 'all'`, GraphQL errors arrive in the result or `onDone` callback. Code that
  checks only `!result` or truthiness takes the success branch. Look for checks on `__typename`
  of a success type and on `errors?.length`.
- A wrapper that registers `onError` can make `await mutate()` resolve to `null`; code that
  assigns the result without a check commits bad state.
- A loading flag set before a query and cleared only in `onResult` or `onDone`.

## Retry after uncertain completion

- Retry or error links that replay mutations (order submit, payment, cart merge).
- Code that deletes an identity cookie or cart id before the replacement is confirmed.

## Overlapping writes and stale responses

- Debounced quantity or form writes sharing one timer across rows.
- The UI showing the last server value while the user's write is still pending.
- Watchers on route query that start a fetch without cancelling the previous one.

## Unmount and navigation

- `watch`, `watchEffect` and `onScopeDispose` registered after an `await` in async `setup`: they
  are not stopped on unmount unless an effect scope created before the `await` owns them.
- Modals and scroll locks opened from components with no route-leave cleanup.
- `useState` flags that survive a navigation.

## Identity change and other tabs

- Login, logout and guest-to-user transitions that reset some Pinia stores but not others.
- `BroadcastChannel` or storage events that carry a logout but not the store reset.
- Merges (cart, wishlist) that clear the guest source before the server confirms.

## Server-side render and hydration

- Module-level state shared between requests on the server.
- Breakpoint or client-only flags that differ between the server render and the first client
  render (hydration mismatch).
- Cookies written during SSR and read again on the client.

## Pending-action and overlay ownership

- One boolean for a scroll lock or overlay with several owners.
- A global modal store opened from components that never close it.
