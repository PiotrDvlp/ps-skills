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

### Capturing GraphQL (or any fetch) responses

Wrap `window.fetch` inside the page and read the buffer back with `page.evaluate`. Install the wrapper after the last full-page `goto`: a full navigation discards it.

```javascript
const page = await browser.getPage("main");
await page.evaluate(() => {
  window.__gql = [];
  const orig = window.fetch;
  window.fetch = async (input, init) => {
    const res = await orig(input, init);
    const url = typeof input === "string" ? input : input.url;
    if (/graphql/.test(url)) {
      const body = String((init && init.body) || "");
      res.clone().text().then((t) => window.__gql.push({
        ops: (body.match(/"operationName":"(\w+)"/g) || []).join(","),
        status: res.status,
        text: t.slice(0, 2000),
      }));
    }
    return res;
  };
});
await page.getByRole("button", { name: "Submit" }).click();
await page.waitForTimeout(8000);
console.log(JSON.stringify(await page.evaluate(() => window.__gql), null, 1));
```

- Do not use `page.route` for this here: on 2026-10-15 a regex and a glob route both captured 0 requests across a client-side navigation, and a route plus an in-page `fetch` hung the script until the 60 s timeout.
- `page.on("response")` / `page.on("requestfinished")` handlers that read bodies logged nothing; `page.on("request")` sees URLs only.
- Queries made during server-side rendering never reach the browser. Trigger them by client-side navigation (click an in-app link, not `goto`), or read the rendered page.
- Log console errors (`page.on("console")`, type `error`) as well: an error the UI swallows, such as a mutation validation error, may appear only there.
- Accept a cookie banner first: it intercepts clicks and the script times out on the next locator.

Verified 2026-10-15 on a Nuxt 4 + Apollo shop: the wrapper captured a probe query, `CategoryByUrl` after a menu click, and a tracking mutation.
