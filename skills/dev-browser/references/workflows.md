# Common workflows reference (dev-browser skill)

## Common workflows

The recipes use the heredoc form to keep them short. Under the Claude Code sandbox, save the script body to `~/.dev-browser/<name>.js` and run `dev-browser --headless --timeout 30 run ~/.dev-browser/<name>.js` as the only command (see SKILL.md Gotchas).

### Data scraping

```bash
dev-browser <<'EOF'
const page = await browser.getPage("scraper");
await page.goto("https://example.com/products");
const items = await page.$$eval(".product", els =>
  els.map(el => ({
    name: el.querySelector("h2")?.textContent?.trim(),
    price: el.querySelector(".price")?.textContent?.trim()
  }))
);
console.log(JSON.stringify(items, null, 2));
EOF
```

### Page screenshot

```bash
dev-browser <<'EOF'
const page = await browser.getPage("shot");
await page.goto("https://example.com");
await page.waitForLoadState("networkidle");
const buf = await page.screenshot({ fullPage: true });
const path = await saveScreenshot(buf, "page.png");
console.log("Screenshot saved:", path);
EOF
```

### Form filling

```bash
dev-browser <<'EOF'
const page = await browser.getPage("form");
await page.goto("https://example.com/login");
await page.fill("#email", "user@example.com");
await page.fill("#password", "password123");
await page.click("button[type=submit]");
await page.waitForURL("**/dashboard");
console.log("Logged in, URL:", page.url());
EOF
```

### Page structure analysis (snapshotForAI)

```bash
dev-browser <<'EOF'
const page = await browser.getPage("analyze");
await page.goto("https://example.com");
const { full } = await page.snapshotForAI();
console.log(full);
EOF
```

### Mobile LCP and image requests (Lighthouse-mobile approximation)

Answers "which image does a phone load, and which element is the LCP?". It is not Lighthouse: no CPU or network throttling. For a real Lighthouse run, use the PageSpeed Insights API below.

```javascript
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true });
await cdp.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse" });
const images = [];
page.on("request", (r) => { if (r.resourceType() === "image") images.push(r.url().split("/").pop()); });
await page.goto("https://example.com/?nocache=" + Date.now(), { waitUntil: "load", timeout: 45000 });
await page.waitForTimeout(3000);
const result = await page.evaluate(() => new Promise((resolve) => {
  const preloads = [...document.querySelectorAll("link[rel=preload][as=image]")].map((l) => ({ href: l.href.split("/").pop(), media: l.media }));
  new PerformanceObserver((list) => {
    const e = list.getEntries().pop();
    resolve({ preloads, lcp: { url: e.url.split("/").pop(), size: e.size, tag: e.element?.tagName } });
  }).observe({ type: "largest-contentful-paint", buffered: true });
  setTimeout(() => resolve({ preloads, lcp: null }), 2000);
}));
console.log(JSON.stringify({ ...result, images }, null, 2));
```

Read LCP with a `PerformanceObserver` and `buffered: true`. `performance.getEntriesByType("largest-contentful-paint")` returns `[]` in this setup.

### Real Lighthouse via the PageSpeed Insights API

No browser and no install. It works only for public URLs (not localhost):

```
https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?url=<url-encoded page>&strategy=mobile&category=performance&key=<API key>
```

Useful fields: `lighthouseResult.audits["largest-contentful-paint-element"].details`, `lighthouseResult.audits["network-requests"].details.items[].url`. Without `key=` the shared quota can be used up: a keyless call on 2026-10-08 returned HTTP 429. A key comes from a Google Cloud project with the PageSpeed Insights API enabled.

### Accessibility audit (axe-core)

Runs the axe-core WCAG 2.x A/AA rules against the rendered page. Works on localhost and behind a login (use a named page). axe checks only the machine-checkable subset of WCAG: keyboard access, focus order, focus traps, announced status messages and the meaning of alt or link text still need a manual check.

```javascript
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("Page.setBypassCSP", { enabled: true });
await page.goto("https://example.com", { waitUntil: "load" });
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/axe-core@4.10.3/axe.min.js" });
const result = await page.evaluate(async () => {
  const r = await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] });
  const summarize = (list) => list.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    count: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));
  return { violations: summarize(r.violations), incomplete: summarize(r.incomplete) };
});
console.log(JSON.stringify(result, null, 2));
```

- Send `Page.setBypassCSP` before `goto`. Without it, a strict CSP blocks the injected script: `Loading the script '...axe.min.js' violates the following Content Security Policy directive`.
- `incomplete` lists checks axe could not decide, for example contrast of text over a gradient or an image. Review them by hand; they are not passes.
- Return the summary, not the raw axe result: it can be hundreds of KB (see the large-string gotcha in SKILL.md).
- To audit one component, pass a selector such as `"#checkout"` instead of `document`.

Verified 2026-10-09 on known-bad HTML: 6 planted violations reported, gradient-background contrast reported under `incomplete`.

### Cross-browser load check (Firefox and WebKit)

dev-browser itself is Chromium-only: the daemon imports only `chromium` and relies on CDP. For Firefox and WebKit, use the standalone Node script `~/.dev-browser/xbrowser.mjs`. It is plain Node, not a dev-browser script, and uses the Playwright installed in `~/.dev-browser/node_modules`.

```bash
node ~/.dev-browser/xbrowser.mjs https://localhost:3000/p/example --ready '[data-testid="product-title"]' --ignore-https-errors
```

- Run it with the Claude Code sandbox off. Inside the sandbox, WebKit launch hangs with no error and Firefox fails on `newPage`; the script then reports `failure.stage: "launch"` after its 60 s per-engine deadline.
- Output is JSON: per engine `browserVersion`, `finalUrl`, `screenshot` (under `~/.dev-browser/tmp/xbrowser/<timestamp>/`), `consoleErrors`, `pageErrors`, `failure`. Exit 0 clean, 1 errors captured, 2 an engine did not complete or an argument is invalid (unknown flag, `--ready` without a value, `--ready=<selector>`).
- Pass `--ready <selector>` for any app that renders client-side. Without it the screenshot shows only that the page loaded (after `domcontentloaded` + 1 s), not that it hydrated.
- Each run uses a fresh context: no cookies, login, consent or cart. Load checks only; interaction flows are not supported yet.
- Playwright WebKit is not Safari and Playwright Firefox is a patched build. For a bug that shows only in real Safari, use `/usr/bin/safaridriver` (needs `sudo safaridriver --enable` and Safari "Allow Remote Automation").
- The axe recipe above does not port: `Page.setBypassCSP` is CDP-only.
- Missing browser after a reinstall (`npm install` in `~/.dev-browser` can bump Playwright within `^1.52.0`): `cd ~/.dev-browser && node node_modules/playwright/cli.js install firefox webkit`. Do not use `npx playwright install`, which can fetch a different Playwright version.

Verified 2026-10-14 (Playwright 1.58.2, Firefox 146.0.1, WebKit 26.0) on local fixtures: clean page exit 0; page with a planted `console.error` and an uncaught throw exit 1 with both errors captured in each engine; missing `--ready` selector exit 2 with `stage: "ready"`; run inside the sandbox exit 2 after 61 s.
