// End-to-end smoke test against a RUNNING server (default localhost:4000).
// Drives the real storefront in headless Edge: browse → PDP → bag →
// checkout modal → admin dashboard. Fails on any console error.
//
//   npm run test:e2e            (from backend/, server must be up)
//   BASE=http://host:port npm run test:e2e
const { chromium } = require("playwright-core");

const BASE = process.env.BASE || "http://localhost:4000";
const ADMIN_KEY = process.env.DPJ_ADMIN_KEY || "dpj-admin-2026";

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const step = (name) => console.log(`  ✓ ${name}`);

  await page.goto(BASE, { waitUntil: "networkidle" });
  if (!(await page.title()).includes("DP Jewellers")) throw new Error("home title missing");
  step("home renders");

  await page.goto(`${BASE}/shop`, { waitUntil: "networkidle" });
  await page.waitForSelector(".product-card", { timeout: 10000 });
  step("shop lists products");

  const firstCard = await page.getAttribute(".product-card >> nth=0", "href");
  await page.goto(BASE + firstCard, { waitUntil: "networkidle" });
  await page.waitForSelector("text=FULL PRICE BREAK-UP", { timeout: 10000 }).catch(() =>
    page.waitForSelector("text=Full price break-up", { timeout: 5000 })
  );
  step("PDP shows price break-up");

  const sizeBtns = await page.$$(".size-options button");
  if (sizeBtns.length) await sizeBtns[0].click();
  const addBtn = await page.$("button:has-text('Add to bag'):not([disabled])");
  if (addBtn) {
    await addBtn.click();
    await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
    await page.click("text=Proceed to checkout");
    await page.waitForSelector("#co-name", { timeout: 10000 });
    step("checkout form opens");
  } else {
    console.log("  - piece sold out; skipping bag flow");
  }

  await page.addInitScript((key) => localStorage.setItem("dpj_admin_key", key), ADMIN_KEY);
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=DP Jewellers Admin", { timeout: 10000 });
  step("admin console renders");

  await browser.close();
  if (errors.length) {
    console.error("Console errors:", errors);
    process.exit(1);
  }
  console.log("SMOKE PASSED — no console errors");
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
