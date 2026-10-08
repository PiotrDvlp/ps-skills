---
name: dev-browser
description: "Use when a task needs a real browser — navigating, clicking, filling forms, screenshots, scraping, logging in, or testing a rendered page. Triggers on \"go to [url]\", \"take a screenshot\", \"check the page\", \"log in\". Skip when plain HTTP fetching suffices (WebFetch/curl)."
allowed-tools: Bash(dev-browser *)
---

# Dev Browser

CLI for controlling a browser via sandboxed JavaScript scripts (Playwright Page API).

## Installation

Requires `npm i -g dev-browser@0.2.5` (newer CLI versions changed the API); run `dev-browser install` once for Chromium.

## Usage

Scripts run in a QuickJS sandbox (NOT Node.js). Available globals:
- `browser` — preconnected browser handle
- `console` — log, warn, error, info
- `setTimeout` / `clearTimeout` — timers
- `saveScreenshot(buf, name)` / `writeFile(name, data)` — save file to tmp (async)
- `readFile(name)` — read file from tmp (async)

**NOT AVAILABLE:** `require()`, `import()`, `process`, `fs`, `fetch`, `WebSocket`, `__dirname`

## Invocation methods

Under the Claude Code sandbox, write the script to a file with the Write tool and run it bare (see Gotchas). Outside the sandbox, the heredoc and pipe forms also work.

```bash
# From file — preferred: the only command in the Bash call
dev-browser --headless --timeout 30 run ~/.dev-browser/check.js

# Inline script (heredoc)
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF

# From pipe
echo 'console.log(await browser.listPages())' | dev-browser

# Headless (no browser window)
dev-browser --headless <<'EOF'
const page = await browser.getPage("bg");
await page.goto("https://example.com");
console.log(await page.textContent("h1"));
EOF

# Connect to existing browser (Chrome with --remote-debugging-port=9222)
dev-browser --connect <<'EOF'
const page = await browser.getPage("main");
console.log(await page.title());
EOF
```

## CLI flags

Verified against `dev-browser --help` on 2026-08-16. When editing this section, read
`--help` first — do not infer flag semantics from the Playwright API.

```bash
# Commands
dev-browser run <file>           # Run script from file
dev-browser install              # Install Playwright browsers (Chromium)
dev-browser install-skill        # Install the dev-browser skill into agent skill dirs
dev-browser browsers             # List managed browser instances
dev-browser status               # Show daemon status
dev-browser stop                 # Stop the daemon and all browsers

# Options
dev-browser --browser <name>     # Named browser instance, separate state (default: "default")
dev-browser --connect [url]      # Connect to existing browser (CDP); omit url to auto-discover
dev-browser --headless           # No visible window — daemon-launched browsers only
dev-browser --ignore-https-errors # Accept self-signed certs (daemon-launched browsers only)
dev-browser --timeout <SECONDS>  # Max script execution time. DEFAULT: 30 seconds
```

**`--timeout` is SECONDS (default 30); in-script Playwright options like `{ timeout: 5000 }` stay milliseconds. `--timeout 10000` is 2.8 hours, not 10 s — use `--timeout 10` to fail fast.**

`--headless` and `--ignore-https-errors` affect only daemon-launched browsers; both are
inert under `--connect`, which attaches to a browser someone else already started.

## Browser API

Full API (pages, navigation, locators, snapshotForAI, screenshots, evaluate, sandbox files) is in references/api.md — read it before writing any script. `${CLAUDE_SKILL_DIR}` is the directory holding this file; `references/...` paths are relative to it, and Codex does not substitute the variable.

## Common workflows

Copy-paste recipes (scraping, screenshots, form filling, structure analysis, mobile device emulation and LCP, real Lighthouse via the PageSpeed Insights API) are in references/workflows.md.

## Debugging and troubleshooting

When a script fails, the named page stays where it stopped. You can go back to it:

```bash
dev-browser <<'EOF'
const page = await browser.getPage("checkout");
const path = await saveScreenshot(await page.screenshot(), "debug.png");
console.log(JSON.stringify({
  screenshot: path,
  url: page.url(),
  title: await page.title(),
}, null, 2));
EOF
```

**Common issues:**
- Element not found → use `snapshotForAI()` to see what's on the page
- Script hangs → `--timeout 10`
- Page not loaded → add `await page.waitForLoadState("networkidle")` before interacting

## Important rules

- **Named pages** (`getPage("name")`) persist between scripts — session state, cookies, localStorage preserved
- **Anonymous pages** (`newPage()`) close when the script ends
- File I/O restricted to `~/.dev-browser/tmp/`
- Daemon starts automatically in the background on first use
- Use `console.log(JSON.stringify(...))` for structured output
- `snapshotForAI()` for structure, `screenshot()` for appearance

## Gotchas

- **Under the Claude Code sandbox, only a bare file run works.** `dev-browser:*` in `sandbox.excludedCommands` applies only when `dev-browser ... run <file>` is the whole Bash call. A heredoc, a pipe, or a second command in the same call (`cat > x.js <<EOF ...` then `dev-browser run x.js`) keeps it sandboxed, and it fails with `Daemon failed to start within 5 seconds`, even when the daemon is already up. Do not put the script under `$TMPDIR`: a run with the sandbox off gets a different `$TMPDIR` and reports `No such file or directory`. Write it to `~/.dev-browser/` with the Write tool. Verified 2026-10-08.
- **Scripts run in a QuickJS sandbox, NOT Node.** `require`, `import`, `process`, `fs`, `fetch`, `WebSocket`, and `__dirname` are all undefined. Reaching for them is the most common failure — use the provided globals (`browser`, `saveScreenshot`, `readFile`/`writeFile`) instead.
- **Named vs anonymous pages differ in lifetime.** `getPage("name")` persists cookies/localStorage between script runs; `newPage()` closes when the script ends. Use a named page when you need session state across invocations.
- **`--timeout` is SECONDS (default 30); a millisecond-style value such as `10000` silently disarms it** — verify flags against `dev-browser --help`, not the Playwright API, whose timeouts are milliseconds.
- **File I/O is jailed to `~/.dev-browser/tmp/`** — you can't read or write elsewhere from a script.
- **Never pull a full HTML response into the sandbox** (`page.content()`, `response.text()` on a page-sized body). A 500 KB string crashed QuickJS with a `gc_obj_list` assertion, which killed the daemon and every browser. Read state inside the page with `page.evaluate(...)` and return small JSON.
- **A daemon restart drops the cookies of named pages.** "Named pages persist" holds only while the daemon lives; after a crash or `dev-browser stop`, rebuild session state (cart, login, selected store) before comparing a run with an earlier one.
- **Pinia state on a Nuxt page:** `page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia.state.value)))` returns every store. Narrow it to one store (`.state.value.cart`) to keep the output small. Verified on a Nuxt 4 app in `nuxt dev` (2026-10-07).
