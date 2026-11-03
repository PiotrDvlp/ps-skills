# Common Mistakes


| Mistake | Fix |
|---|---|
| Running the extension when no note was written | Phase 3 step 5 runs only after step 2 wrote a note; without a notes root say "extension skipped, no note written" |
| Passing raw user input to `cs-atlassian` | Normalize first (Phase 0b): trim, extract from URL, strip `[[...]]`, uppercase, regex-validate |
| Running Phase 1 only to discover the CLI is missing | Phase 0a verifies `cs-atlassian` before any subagent dispatch — never reorder |
| Adding `<project>` as a semantic tag (e.g. `acme` in tags when project is acme) | Project name is in `tags:` mechanically; semantic tags must be content-driven |
| Re-running the audit and silently clobbering yesterday's note | Phase 0f's "match from a previous day" branch creates a fresh dated note and keeps both |
| Running re-audit detection only at write time (after ~60s of fetch + analysis work) | Phase 0f runs the grep before any subagent dispatch — if the user picks Abort, no subagent cost is paid. Phase 3 just applies the filename Phase 0f resolved. |
| Rendering a WARNING or MISSING_ASSETS bullet without a `Default:` sentence | Phase 3 rejects the analysis and re-dispatches once, naming the gap IDs that lack it |
