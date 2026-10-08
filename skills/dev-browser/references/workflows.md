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
