# Common workflows reference (dev-browser skill)

## Common workflows

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
