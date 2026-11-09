# Search cues (any stack)

Implicit state machines hide where code handles one situation instead of following a rule. These
cues are places to look, not findings. The special-case list comes from the `untangle-codebase`
skill, which treats the same code as a design signal.

## Special cases

- A swallowed exception: an empty `catch`, or an error callback that only logs.
- A retry or a sleep: a fixed delay, a retry loop, a "wait until ready" timer.
- A global flag set by another module, or a module that reads state another module writes.
- An `if` for one value, or a parameter only one caller passes.
- A call order callers just have to know (init before use, reset after logout).
- A disabled test near stateful code.

## State holders

- Module-level variables and singletons.
- Stores and caches, including request caches with optimistic updates.
- Cookies, local and session storage, URL query state.
- Busy, loading, submitting and pending flags; counters of pending work.
- Timers, debouncers and intervals stored in one shared slot.

## Questions per holder

- Who writes it? Read every writer, not only the obvious one.
- Is every terminal state (success, error, cancel, unmount) followed by a reset?
- Is the reset in a `finally`, or only on success?
- Is a source (a cookie, a dedup key, a previous id) cleared before its effect is confirmed?
- Does a late response overwrite a newer intent?
- Does a retry replay something that is not idempotent?
- Does another tab or another identity see the change?
