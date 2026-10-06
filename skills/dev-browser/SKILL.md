---
name: dev-browser
description: "Use when a task needs a real browser — navigating, clicking, filling forms, screenshots, scraping, logging in, or testing a rendered page. Triggers on \"go to [url]\", \"take a screenshot\", \"check the page\", \"log in\". Skip when plain HTTP fetching suffices (WebFetch/curl)."
allowed-tools: Bash(dev-browser *)
---

# Dev Browser

CLI for controlling a browser via sandboxed JavaScript scripts (Playwright Page API).

## Installation

Already installed globally (`dev-browser@0.2.5`); `dev-browser install` only if Chromium is missing.

## Usage

Scripts run in a QuickJS sandbox (NOT Node.js). Available globals:
- `browser` — preconnected browser handle
- `console` — log, warn, error, info
- `setTimeout` / `clearTimeout` — timers
- `saveScreenshot(buf, name)` / `writeFile(name, data)` — save file to tmp (async)
- `readFile(name)` — read file from tmp (async)

**NOT AVAILABLE:** `require()`, `import()`, `process`, `fs`, `fetch`, `WebSocket`, `__dirname`

## Invocation methods

```bash
# Inline script (heredoc) — preferred method
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF

# From file
dev-browser run script.js

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

Full API (pages, navigation, locators, snapshotForAI, screenshots, evaluate, sandbox files) is in references/api.md — read it before writing any script.

## Common workflows

Copy-paste recipes (scraping, screenshots, form filling, structure analysis) are in references/workflows.md.

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

- **Scripts run in a QuickJS sandbox, NOT Node.** `require`, `import`, `process`, `fs`, `fetch`, `WebSocket`, and `__dirname` are all undefined. Reaching for them is the most common failure — use the provided globals (`browser`, `saveScreenshot`, `readFile`/`writeFile`) instead.
- **Named vs anonymous pages differ in lifetime.** `getPage("name")` persists cookies/localStorage between script runs; `newPage()` closes when the script ends. Use a named page when you need session state across invocations.
- **`--timeout` is SECONDS (default 30); a millisecond-style value such as `10000` silently disarms it** — verify flags against `dev-browser --help`, not the Playwright API, whose timeouts are milliseconds.
- **File I/O is jailed to `~/.dev-browser/tmp/`** — you can't read or write elsewhere from a script.
