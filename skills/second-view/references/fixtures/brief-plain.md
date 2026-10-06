=== SENT TO CODEX ===
Problem statement
Choose a state-management approach for a checkout flow with three steps.

Constraints
Vue 3 composition API, existing Pinia stores, no new dependencies.

Success criteria
Back-navigation preserves entered data; a refresh does not lose the cart.

Ruled out
Storing the whole flow in the URL, because the payment step carries PII.

=== WITHHELD ===
Current direction
Lean toward one Pinia store scoped to the flow, cleared on completion.
