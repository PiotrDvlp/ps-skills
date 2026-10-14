# Browser API reference (dev-browser skill)

## Browser API (inside scripts)

### Page management

```javascript
// Named pages — persistent between scripts (state, cookies, localStorage)
const page = await browser.getPage("main");

// Anonymous page — closes when script ends
const page2 = await browser.newPage();

// List open tabs
const tabs = await browser.listPages();  // [{id, url, title, name}]

// Close named page
await browser.closePage("main");
```

`browser` has only `getPage`, `newPage`, `listPages` and `closePage`. There is no `browser.newContext`, so the Playwright device options (`deviceScaleFactor`, `isMobile`, `userAgent`) are not available. Emulate a device per page through CDP:

```javascript
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true });
await cdp.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36" });
```

This sets `innerWidth`, `devicePixelRatio`, the `User-Agent` request header and `navigator.userAgent`. It does not enable touch (`(pointer: coarse)` stays false). For viewport size alone, use `page.setViewportSize({ width, height })`.

### Navigation and interaction

```javascript
await page.goto("https://example.com");
await page.click("button.submit");
await page.fill("input[name=email]", "test@test.com");
await page.type("#search", "search query");          // Types character by character
await page.press("#search", "Enter");                // Presses a key
await page.waitForSelector(".result");
await page.waitForURL("**/dashboard");
await page.waitForLoadState("networkidle");
const text = await page.textContent("h1");
const html = await page.innerHTML(".content");
```

### Element targeting (locators)

```javascript
// CSS selectors
await page.click(".btn-primary");
await page.fill("#email", "user@test.com");

// Playwright locators — more resilient to DOM changes
const btn = page.locator("button", { hasText: "Save" });
await btn.click();

// getByRole — accessibility-based, best for dynamic pages
await page.getByRole("button", { name: "Log in" }).click();
await page.getByRole("textbox", { name: "Email" }).fill("test@test.com");
await page.getByRole("link", { name: "Dashboard" }).click();
```

### Snapshot AI — page structure analysis

`snapshotForAI()` returns a simplified DOM representation — ideal for understanding page structure and finding elements instead of guessing selectors.

```javascript
const page = await browser.getPage("analyze");
await page.goto("https://example.com");

// Full snapshot
const { full } = await page.snapshotForAI();
console.log(full);

// With options
const snapshot = await page.snapshotForAI({
  depth: 3,        // DOM tree depth
  timeout: 5000    // Timeout in ms
});
console.log(snapshot.full);

// Act on a ref from the snapshot, then print only what changed
const tracked = await page.snapshotForAI({ track: "main", timeout: 5000 });
// tracked.full contains lines like: - button "Continue" [ref=e12]
await page.getByRef("e12").click({ timeout: 5000 });
console.log((await page.snapshotForAI({ track: "main", timeout: 5000 })).incremental);
```

Refs (`eN`, `fNeN` inside iframes) come from the latest snapshot. Re-snapshot after navigation.

**When to use snapshotForAI vs screenshot:**
- `snapshotForAI()` → when you need structure (selectors, text, interactive elements)
- `page.screenshot()` → when appearance matters (layout, styles, colors)

### Screenshots

```javascript
const buf = await page.screenshot();
const path = await saveScreenshot(buf, "result.png");

// Full page (scroll)
const fullBuf = await page.screenshot({ fullPage: true });
await saveScreenshot(fullBuf, "full-page.png");
```

### JS evaluation on page

```javascript
// Read data from page
const title = await page.evaluate(() => document.title);
const links = await page.$$eval("a", els => els.map(el => el.href));
const price = await page.$eval(".price", el => el.textContent);
```

### Files (sandbox: ~/.dev-browser/tmp/)

```javascript
await writeFile("data.json", JSON.stringify(results));
const content = await readFile("data.json");
```
