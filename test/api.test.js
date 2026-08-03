// API integration tests. Boots the real server once on a test port with an
// isolated throwaway file store (DPJ_DB_FILE + unreachable DATABASE_URL), so
// tests never touch Postgres or real data. Every rule asserted here is a BRD
// requirement enforced server-side.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PORT = 4123;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { "x-admin-key": "dpj-admin-2026", "content-type": "application/json" };
const JSONH = { "content-type": "application/json" };
const tmpDb = path.join(os.tmpdir(), `dpj-test-${process.pid}.json`);
let child;

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const customer = { name: "Test Buyer", phone: "9800000001", address: "1 Test Lane, Indore", pincode: "452001" };
const order = (items, extra = {}) =>
  JSON.stringify({ items, customer, payment: { mode: "upi" }, ...extra });

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "..", "boot.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DPJ_DB_FILE: tmpDb,
      DATABASE_URL: "postgres://none:none@127.0.0.1:1/none", // force file mode
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("test server failed to start");
});

after(() => {
  child?.kill();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(tmpDb + ".tmp", { force: true });
});

test("health reports isolated file storage", async () => {
  const { data } = await api("/api/health");
  assert.equal(data.ok, true);
  assert.equal(data.storage, "file");
});

test("catalogue is seeded and priced on read", async () => {
  const { data } = await api("/api/products");
  assert.ok(data.total >= 24);
  assert.ok(data.items.every((p) => p.price.total > 0));
});

test("COD is refused above the ceiling (FR-CHK)", async () => {
  const { data: list } = await api("/api/products?sort=price-desc&limit=1");
  const expensive = list.items[0];
  assert.ok(expensive.price.total > 50000);
  const { status, data } = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: expensive.slug, size: expensive.sizes?.[0], qty: 1 }], { payment: { mode: "cod" } }),
  });
  assert.equal(status, 400);
  assert.match(data.error, /Cash on delivery/);
});

test("PAN is demanded at ₹2,00,000+ (Rule 114B) and accepted when valid", async () => {
  const { data: list } = await api("/api/products?sort=price-desc&limit=1");
  const item = [{ slug: list.items[0].slug, size: list.items[0].sizes?.[0], qty: 2 }];
  const noPan = await api("/api/payments/intent", { method: "POST", headers: JSONH, body: order(item) });
  assert.equal(noPan.status, 400);
  assert.match(noPan.data.error, /PAN/);
  const withPan = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order(item, { customer: { ...customer, pan: "ABCDE1234F" } }),
  });
  assert.equal(withPan.status, 201);
});

test("payment intent carries a 30-minute price lock (FR-PRC)", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const { status, data } = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order([{ slug: list.items[0].slug, size: list.items[0].sizes?.[0], qty: 1 }]),
  });
  assert.equal(status, 201);
  const minutes = (new Date(data.lockedUntil) - Date.now()) / 60000;
  assert.ok(minutes > 28 && minutes < 32, `lock was ${minutes} min`);
});

test("full purchase: intent → confirm → track → GST invoice adds up", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const intent = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order([{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }]),
  });
  const conf = await api(`/api/payments/${intent.data.intentId}/confirm`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ outcome: "success" }),
  });
  assert.equal(conf.status, 201);

  const track = await api(`/api/track?orderId=${conf.data.orderId}&phone=${customer.phone}`);
  assert.equal(track.data.status, "Confirmed");
  assert.equal(track.data.invoiceAvailable, true);

  const inv = await api(`/api/orders/${conf.data.orderId}/invoice?phone=${customer.phone}`);
  assert.match(inv.data.invoice.number, /^INV\/\d\d-\d\d\/\d{4}$/);
  for (const line of inv.data.lines) {
    assert.equal(line.cgst + line.sgst, line.gst);
    assert.equal(line.taxable + line.gst, line.gross);
  }
  assert.match(inv.data.amountInWords, /Rupees Only$/);
});

test("failed payment keeps the bag and creates no order", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const intent = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order([{ slug: list.items[0].slug, size: list.items[0].sizes?.[0], qty: 1 }]),
  });
  const conf = await api(`/api/payments/${intent.data.intentId}/confirm`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ outcome: "failure" }),
  });
  assert.equal(conf.status, 402);
});

test("stock is enforced at checkout (FR-INV)", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const slug = list.items[0].slug;
  const set = await api(`/api/admin/products/${slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ stock: 1 }),
  });
  assert.equal(set.status, 200);
  const { status, data } = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order([{ slug, size: list.items[0].sizes?.[0], qty: 2 }]),
  });
  assert.equal(status, 409);
  assert.match(data.error, /Only 1/);
  await api(`/api/admin/products/${slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ stock: 6 }),
  });
});

test("engraving is rejected on non-engravable pieces (FR-PDP-12)", async () => {
  const { status, data } = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order([{ slug: "aurelia-solitaire-ring", size: "12", qty: 1, engraving: "HELLO" }]),
  });
  assert.equal(status, 400);
  assert.match(data.error, /cannot be engraved/);
});

test("admin endpoints refuse a wrong key", async () => {
  const { status } = await api("/api/admin/summary", { headers: { "x-admin-key": "wrong" } });
  assert.equal(status, 401);
});

test("rate console: margin guard and maker-checker separation (FR-PRC-10/11)", async () => {
  const fat = await api("/api/admin/rates/proposals", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({ metal: "gold", purity: "22K", value: 9580 * 1.5, maker: "asha" }),
  });
  assert.equal(fat.status, 400);
  assert.match(fat.data.error, /Guard/);

  const ok = await api("/api/admin/rates/proposals", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({ metal: "gold", purity: "22K", value: 9600, maker: "asha" }),
  });
  assert.equal(ok.status, 201);
  const self = await api(`/api/admin/rates/proposals/${ok.data.id}/approve`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ checker: "asha" }),
  });
  assert.equal(self.status, 400);
  const other = await api(`/api/admin/rates/proposals/${ok.data.id}/approve`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ checker: "vikram" }),
  });
  assert.equal(other.status, 200);
});

test("returns open only after delivery (FR-RET)", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const intent = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order([{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }]),
  });
  const conf = await api(`/api/payments/${intent.data.intentId}/confirm`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ outcome: "success" }),
  });
  const ret = await api("/api/returns", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({ orderId: conf.data.orderId, phone: customer.phone, slug: cheap.slug, size: cheap.sizes?.[0] || null, type: "return", reason: "Changed my mind" }),
  });
  assert.equal(ret.status, 400);
  assert.match(ret.data.error, /delivered/i);
});

test("loyalty: earn on delivery, tiered balance, capped redemption", async () => {
  // sign in to get a session (points redemption is session-verified)
  const phone = "9800000003";
  const otpRes = await api("/api/auth/otp", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone }),
  });
  const auth = await api("/api/auth/verify", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone, otp: otpRes.data.demoOtp }),
  });
  const token = auth.data.token;

  // place + deliver an order to earn points
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const buyer = { name: "Loyal Buyer", phone, address: "2 Rewards Road, Indore", pincode: "452001" };
  const intent = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({ items: [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }], customer: buyer, payment: { mode: "upi" } }),
  });
  const conf = await api(`/api/payments/${intent.data.intentId}/confirm`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ outcome: "success" }),
  });
  for (const status of ["Under Quality Check", "Packed", "Shipped", "Out for Delivery", "Delivered"]) {
    const move = await api(`/api/admin/orders/${conf.data.orderId}/status`, {
      method: "PATCH", headers: ADMIN, body: JSON.stringify({ status }),
    });
    assert.equal(move.status, 200);
  }

  const me = await api("/api/loyalty/me", { headers: { "x-auth-token": token } });
  const expected = Math.floor((conf.data.total / 100) * 2); // Silver = 1×, 2 pts per ₹100
  assert.equal(me.data.points, expected);
  assert.equal(me.data.tier.name, "Silver");
  assert.match(me.data.referralCode, /^DPJ[0-9A-F]{6}$/);

  // redeem more than the cap → clamped server-side to 25% of the bag
  const redeem = await api("/api/payments/intent", {
    method: "POST", headers: { ...JSONH, "x-auth-token": token },
    body: JSON.stringify({
      items: [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }],
      customer: buyer, payment: { mode: "upi" }, redeemPoints: expected,
    }),
  });
  assert.equal(redeem.status, 201);
  const cap = Math.floor((conf.data.total * 25) / 100);
  assert.equal(redeem.data.amount, conf.data.total - Math.min(expected, cap));

  // redeeming without a session is refused
  const anon = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      items: [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }],
      customer: buyer, payment: { mode: "upi" }, redeemPoints: 10,
    }),
  });
  assert.equal(anon.status, 401);
});

test("referral: self-referral and repeat buyers are refused", async () => {
  const phone = "9800000004";
  const otpRes = await api("/api/auth/otp", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone }),
  });
  const auth = await api("/api/auth/verify", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone, otp: otpRes.data.demoOtp }),
  });
  const my = await api("/api/loyalty/me", { headers: { "x-auth-token": auth.data.token } });
  const code = my.data.referralCode;

  const { data: list } = await api("/api/products?sort=price-desc&limit=2");
  const item = [{ slug: list.items[1].slug, size: list.items[1].sizes?.[0], qty: 1 }];

  const self = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      items: item,
      customer: { name: "Self Referrer", phone, address: "3 Loop Lane, Indore", pincode: "452001", pan: "ABCDE1234F" },
      payment: { mode: "upi" }, referralCode: code,
    }),
  });
  assert.equal(self.status, 400);
  assert.match(self.data.error, /refer yourself/);

  // 9800000001 already ordered in earlier tests → not a first order
  const repeat = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      items: item,
      customer: { name: "Test Buyer", phone: "9800000001", address: "1 Test Lane, Indore", pincode: "452001", pan: "ABCDE1234F" },
      payment: { mode: "upi" }, referralCode: code,
    }),
  });
  assert.equal(repeat.status, 400);
  assert.match(repeat.data.error, /first orders/);
});

test("referral: valid first order gets the flat discount", async () => {
  const otpRes = await api("/api/auth/otp", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000005" }),
  });
  const auth = await api("/api/auth/verify", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000005", otp: otpRes.data.demoOtp }),
  });
  const my = await api("/api/loyalty/me", { headers: { "x-auth-token": auth.data.token } });

  const { data: list } = await api("/api/products?sort=price-desc&limit=2");
  const pick = list.items[1];
  const withRef = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      items: [{ slug: pick.slug, size: pick.sizes?.[0], qty: 1 }],
      customer: { name: "New Friend", phone: "9800000006", address: "6 Fresh Ave, Indore", pincode: "452001", pan: "FGHIJ5678K" },
      payment: { mode: "upi" }, referralCode: my.data.referralCode,
    }),
  });
  assert.equal(withRef.status, 201);
  assert.equal(withRef.data.discount, 500);
});

test("OTP hardening: resend throttled, brute force burns the code", async () => {
  const phone = "9800000007";
  const first = await api("/api/auth/otp", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone }),
  });
  assert.equal(first.status, 200);

  // immediate resend → throttled
  const again = await api("/api/auth/otp", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone }),
  });
  assert.equal(again.status, 429);

  // five wrong guesses are 400s, the sixth burns the code with 429
  const wrong = first.data.demoOtp === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    const bad = await api("/api/auth/verify", {
      method: "POST", headers: JSONH, body: JSON.stringify({ phone, otp: wrong }),
    });
    assert.equal(bad.status, 400);
  }
  const burned = await api("/api/auth/verify", {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone, otp: first.data.demoOtp }),
  });
  assert.equal(burned.status, 429);
});

test("business rules are editable and enforced live (FR-ADM-08)", async () => {
  // out-of-range value refused
  const bad = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ codCeiling: 999999 }),
  });
  assert.equal(bad.status, 400);

  // lower the COD ceiling below the cheapest product → COD refused everywhere
  const set = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ codCeiling: 1000 }),
  });
  assert.equal(set.status, 200);
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const cod = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }], { payment: { mode: "cod" } }),
  });
  assert.equal(cod.status, 400);
  assert.match(cod.data.error, /1,000/);

  // restore, and the change trail is in the audit log
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ codCeiling: 50000 }),
  });
  const log = await api("/api/admin/audit", { headers: ADMIN });
  assert.ok(log.data.some((r) => r.action === "settings" && /codCeiling/.test(r.detail)));
});

test("admin can create a product that goes live immediately", async () => {
  const body = {
    name: "Test Atelier Band",
    category: "rings",
    metalType: "gold",
    purity: "22K",
    grossWeight: 5.2,
    netWeight: 5.0,
    making: { basis: "perGram", value: 700 },
    sizes: "10, 12",
    stock: 4,
  };
  const created = await api("/api/admin/products", {
    method: "POST", headers: ADMIN, body: JSON.stringify(body),
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.slug, "test-atelier-band");
  assert.ok(created.data.price > 0);

  // live on the storefront with computed price + stock + sizes
  const pdp = await api("/api/products/test-atelier-band");
  assert.equal(pdp.status, 200);
  assert.equal(pdp.data.product.stock, 4);
  assert.deepEqual(pdp.data.product.sizes, ["10", "12"]);
  assert.equal(pdp.data.product.price.total, created.data.price);

  // duplicate slug refused; bad weights refused
  const dupe = await api("/api/admin/products", {
    method: "POST", headers: ADMIN, body: JSON.stringify(body),
  });
  assert.equal(dupe.status, 400);
  const badW = await api("/api/admin/products", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({ ...body, name: "Bad Weights", slug: "bad-weights", netWeight: 9 }),
  });
  assert.equal(badW.status, 400);
});

test("CSV round-trip: template import with quoted cells, stock, sizes; catalogue export", async () => {
  const header = "slug,name,category,metalType,purity,colour,grossWeight,netWeight,makingBasis,makingValue,imageUrl,stock,sizes,description";
  const csv = [
    header,
    'csv-test-hoops,CSV Test Hoops,earrings,silver,925,white,6,6,flat,800,,7,10;12,"Light hoops, rhodium finished — daily wear."',
    "csv-bad-row,Bad Row,earrings,silver,999,white,6,6,flat,800,,,,", // no rate for 999
  ].join("\n");

  const imp = await api("/api/admin/products/csv", {
    method: "POST", headers: ADMIN, body: JSON.stringify({ csv }),
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.created, 1);
  assert.equal(imp.data.errors.length, 1);

  const pdp = await api("/api/products/csv-test-hoops");
  assert.equal(pdp.status, 200);
  assert.equal(pdp.data.product.stock, 7);
  assert.deepEqual(pdp.data.product.sizes, ["10", "12"]);
  assert.match(pdp.data.product.description, /rhodium finished — daily wear/);

  // legacy 11-column header still accepted (updates the same slug)
  const legacy = [
    "slug,name,category,metalType,purity,colour,grossWeight,netWeight,makingBasis,makingValue,imageUrl",
    "csv-test-hoops,CSV Test Hoops II,earrings,silver,925,white,6.5,6.5,flat,850,",
  ].join("\n");
  const imp2 = await api("/api/admin/products/csv", {
    method: "POST", headers: ADMIN, body: JSON.stringify({ csv: legacy }),
  });
  assert.equal(imp2.data.updated, 1);

  // catalogue export carries the full header and the new SKU
  const res = await fetch(`${BASE}/api/admin/export/catalogue.csv?key=dpj-admin-2026`);
  const text = await res.text();
  assert.ok(text.includes(header));
  assert.ok(text.includes("csv-test-hoops"));
  const template = await fetch(`${BASE}/api/admin/export/template.csv?key=dpj-admin-2026`);
  assert.ok((await template.text()).includes("kaveri-gold-band"));
});

test("admin mutations land in the audit trail", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  await api(`/api/admin/products/${list.items[0].slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ stock: 6 }),
  });
  const log = await api("/api/admin/audit", { headers: ADMIN });
  assert.ok(log.data.some((r) => r.action === "catalogue" && r.detail.includes(list.items[0].slug)));
  assert.ok(log.data.some((r) => r.action === "order-status"));
});

test("packing slip hides values for discreet gifts (FR-CHK-05)", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const item = [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }];

  const giftIntent = await api("/api/payments/intent", {
    method: "POST", headers: JSONH,
    body: order(item, { gift: { wrap: true, message: "Happy anniversary", hideInvoiceValue: true } }),
  });
  const conf = await api(`/api/payments/${giftIntent.data.intentId}/confirm`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ outcome: "success" }),
  });

  const slip = await api(`/api/orders/${conf.data.orderId}/packing-slip?phone=${customer.phone}`);
  assert.equal(slip.status, 200);
  assert.equal(slip.data.showPrices, false);
  assert.equal(slip.data.payable, null);
  assert.ok(slip.data.lines.every((l) => l.lineTotal === null));
  assert.equal(slip.data.gift.message, "Happy anniversary");

  // wrong phone, no admin key → not found
  const denied = await api(`/api/orders/${conf.data.orderId}/packing-slip?phone=9999999999`);
  assert.equal(denied.status, 404);
});

test("security headers are present", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("gold scheme accrues grams at the day's 22K rate (FR-GSS)", async () => {
  const enroll = await api("/api/schemes/enroll", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      variant: "swarna-11-1", monthlyAmount: 5000, acceptTerms: true,
      customer: { name: "Test Saver", phone: "9800000002" },
    }),
  });
  assert.equal(enroll.status, 201);
  const pay = await api(`/api/schemes/${enroll.data.id}/pay`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ outcome: "success" }),
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.data.paidCount, 1);
  assert.ok(Math.abs(pay.data.gramsAccrued - 5000 / pay.data.rate22) < 0.001);
});

test("rate console: instant mode + all-gold-purities update (single-operator manual publishing)", async () => {
  const before = await api("/api/admin/rates", { headers: ADMIN });
  assert.equal(before.data.makerChecker, true);
  const gold24 = before.data.rates.gold["24K"];

  // switch off maker-checker in Settings
  const set = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ rateMakerChecker: 0 }),
  });
  assert.equal(set.status, 200);

  // one 24K entry publishes every gold purity instantly, factor-derived
  const v = Math.round(gold24 * 1.02);
  const pub = await api("/api/admin/rates/proposals", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({ metal: "gold", purity: "ALL", value: v, maker: "deepali" }),
  });
  assert.equal(pub.status, 201);
  assert.equal(pub.data.status, "approved");

  const after = await api("/api/admin/rates", { headers: ADMIN });
  assert.equal(after.data.makerChecker, false);
  assert.equal(after.data.rates.gold["24K"], v);
  assert.equal(after.data.rates.gold["22K"], Math.round(v * 0.916));
  assert.equal(after.data.rates.gold["18K"], Math.round(v * 0.75));
  assert.equal(after.data.rates.gold["14K"], Math.round(v * 0.583));
  assert.ok(after.data.audit.some((a) => a.purity === "22K" && /instant/.test(a.checker)));

  // guard still applies in instant mode
  const fat = await api("/api/admin/rates/proposals", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({ metal: "gold", purity: "ALL", value: v * 2, maker: "deepali" }),
  });
  assert.equal(fat.status, 400);

  // restore maker-checker: proposals wait for a second person again
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ rateMakerChecker: 1 }),
  });
  const wait = await api("/api/admin/rates/proposals", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({ metal: "silver", purity: "925", value: before.data.rates.silver["925"] + 1, maker: "deepali" }),
  });
  assert.equal(wait.status, 201);
  assert.equal(wait.data.status, "pending");
  await api(`/api/admin/rates/proposals/${wait.data.id}/reject`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ checker: "cleanup" }),
  });
});

test("complete product details survive single-create, CSV import and export round-trip", async () => {
  // single create with stone, charges, HUID, made-to-order
  const created = await api("/api/admin/products", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({
      name: "Test Full Solitaire", slug: "test-full-solitaire", category: "rings",
      metalType: "gold", purity: "18K", colour: "rose", grossWeight: 3.4, netWeight: 3.1,
      making: { basis: "percent", value: 15 }, sizes: "10, 12", sizeLabel: "Ring size",
      collection: "Test Bridal", gender: "unisex",
      stone: { type: "diamond", caratTotal: 0.3, ratePerCarat: 150000, certBody: "IGI", certNo: "IGI-T-1" },
      hallmarkingCharge: 45, certificationCharge: 600, huid: "TESTA1",
      leadTimeDays: 14, engravable: true,
    }),
  });
  assert.equal(created.status, 201);
  const p = (await api("/api/products/test-full-solitaire")).data.product;
  assert.equal(p.stones[0].certNo, "IGI-T-1");
  assert.equal(p.otherCharges.certification, 600);
  assert.equal(p.huid, "TESTA1");
  assert.equal(p.madeToOrder, true);
  assert.equal(p.collection, "Test Bridal");

  // CSV import with the new optional columns (subset, any order after core)
  const csv = [
    "slug,name,category,metalType,purity,colour,grossWeight,netWeight,makingBasis,makingValue,imageUrl,collection,stoneType,stoneCarat,stoneRatePerCarat,stoneCertBody,certificationCharge,madeToOrder,leadTimeDays,published",
    "test-csv-full,Test CSV Full,earrings,gold,22K,yellow,2.2,2.0,perGram,700,,CSV Bridal,ruby,0.5,42000,GII,350,1,10,1",
  ].join("\r\n");
  const imp = await api("/api/admin/products/csv", {
    method: "POST", headers: ADMIN, body: JSON.stringify({ csv }),
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.created, 1);
  assert.equal(imp.data.errors.length, 0);
  const q = (await api("/api/products/test-csv-full")).data.product;
  assert.equal(q.stones[0].type, "ruby");
  assert.equal(q.stones[0].certBody, "GII");
  assert.equal(q.otherCharges.certification, 350);
  assert.equal(q.madeToOrder, true);
  assert.equal(q.leadTimeDays, 10);
  assert.equal(q.collection, "CSV Bridal");

  // bad stone row is reported, not silently dropped
  const bad = await api("/api/admin/products/csv", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({
      csv: "slug,name,category,metalType,purity,colour,grossWeight,netWeight,makingBasis,makingValue,imageUrl,stoneType\r\n" +
        "test-bad-stone,Bad Stone,rings,gold,22K,yellow,2,2,flat,500,,emerald",
    }),
  });
  assert.equal(bad.data.errors.length, 1);
  assert.match(bad.data.errors[0].error, /stoneCarat/);

  // export now carries the full column set
  const res = await fetch(`${BASE}/api/admin/export/catalogue.csv?key=dpj-admin-2026`);
  const text = await res.text();
  const header = text.split(/\r?\n/)[0].replace(/^\uFEFF/, "");
  for (const c of ["stoneType", "certificationCharge", "huid", "madeToOrder", "extraImages", "occasion"])
    assert.ok(header.includes(c), `export header missing ${c}`);
  const row = text.split(/\r?\n/).find((l) => l.startsWith("test-csv-full,"));
  assert.ok(row.includes("ruby") && row.includes("GII"));

  // tidy up: unpublish both test SKUs
  for (const slug of ["test-full-solitaire", "test-csv-full"])
    await api(`/api/admin/products/${slug}`, {
      method: "PATCH", headers: ADMIN, body: JSON.stringify({ published: false }),
    });
});

test("hero media content is publicly readable and admin-editable", async () => {
  const before = await api("/api/content");
  assert.equal(before.status, 200);
  assert.ok(before.data.heroImage.startsWith("http"));

  // no admin key -> refused
  const denied = await api("/api/admin/content", {
    method: "PATCH", headers: JSONH, body: JSON.stringify({ heroImage: "https://x.example/a.jpg" }),
  });
  assert.equal(denied.status, 401);

  // bad URL refused, unknown field refused
  const bad = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ heroImage: "not a url" }),
  });
  assert.equal(bad.status, 400);
  const unknown = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ evil: "https://x.example" }),
  });
  assert.equal(unknown.status, 400);

  // set video -> public content reflects it
  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ heroVideo: "https://cdn.example/hero.mp4" }),
  });
  assert.equal(set.status, 200);
  assert.equal(set.data.changed, 1);
  const pub = await api("/api/content");
  assert.equal(pub.data.heroVideo, "https://cdn.example/hero.mp4");

  // both fields may be blank (video-only heroes clear the image; the
  // storefront falls back to its built-in image when both are empty)
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ heroImage: "", heroVideo: "" }),
  });
  const cleared = await api("/api/content");
  assert.equal(cleared.data.heroImage, "");
  assert.equal(cleared.data.heroVideo, "");

  // restore the default hero image for later tests
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ heroImage: "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?q=80&w=1600&auto=format&fit=crop" }),
  });
});

test("homepage promotion slides: images linked to products, validated", async () => {
  const { data: list } = await api("/api/products?limit=1");
  const slug = list.items[0].slug;

  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({
      heroSlides: [
        { image: "/api/uploads/diwali-promo-abc.jpg", slug },
        { image: "https://cdn.example/plain-banner.jpg" },
      ],
    }),
  });
  assert.equal(set.status, 200);
  const pub = (await api("/api/content")).data;
  assert.equal(pub.heroSlides.length, 2);
  assert.equal(pub.heroSlides[0].slug, slug);
  assert.equal(pub.heroSlides[1].slug, null);

  // guard rails: bad image, unknown product, too many slides
  const badImg = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ heroSlides: [{ image: "not a url", slug }] }),
  });
  assert.equal(badImg.status, 400);
  const badSlug = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ heroSlides: [{ image: "/img/x.jpg", slug: "no-such-piece" }] }),
  });
  assert.equal(badSlug.status, 400);
  assert.match(badSlug.data.error, /not a published product/);
  const tooMany = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ heroSlides: Array(7).fill({ image: "/img/x.jpg" }) }),
  });
  assert.equal(tooMany.status, 400);

  // empty list clears the promotion
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ heroSlides: [] }),
  });
  assert.deepEqual((await api("/api/content")).data.heroSlides, []);
});

test("customer profiles: admin list and per-phone detail across guests too", async () => {
  const noKey = await api("/api/admin/customers");
  assert.equal(noKey.status, 401);

  // the suite's test buyer (9800000001) has placed orders without an account
  const rows = (await api("/api/admin/customers", { headers: ADMIN })).data;
  const buyer = rows.find((r) => r.phone === "9800000001");
  assert.ok(buyer, "buyer appears in the customer list");
  // ordering auto-creates the account, so an order-only phone is registered
  assert.equal(buyer.registered, true);
  assert.ok(buyer.orders >= 1);
  assert.ok(buyer.spend > 0);
  assert.equal(buyer.name, "Test Buyer");

  const detail = (await api("/api/admin/customers/9800000001", { headers: ADMIN })).data;
  assert.equal(detail.name, "Test Buyer");
  // auto-created at first order, delivery address already on file
  assert.ok(detail.account);
  assert.ok(detail.account.addresses.length >= 1);
  assert.equal(detail.stats.orders, buyer.orders);
  assert.ok(detail.orders.length >= 1);
  assert.ok(detail.orders[0].orderId.startsWith("DPJ"));
  assert.ok(Array.isArray(detail.returns) && Array.isArray(detail.schemes) && Array.isArray(detail.callbacks));

  // lifetime value counts only non-cancelled, non-refunded orders
  const validSum = detail.orders.filter((o) => !["Cancelled", "Refunded"].includes(o.status))
    .reduce((s, o) => s + o.payable, 0);
  assert.equal(detail.stats.spend, validSum);

  const missing = await api("/api/admin/customers/9899999998", { headers: ADMIN });
  assert.equal(missing.status, 404);
});

test("regional footfall: orders grouped by PIN circle, showroom bookings counted", async () => {
  assert.equal((await api("/api/admin/footfall")).status, 401);

  // the suite's buyer ships to 452001 → Madhya Pradesh
  const before = (await api("/api/admin/footfall", { headers: ADMIN })).data;
  const mp = before.regions.find((r) => r.region === "Madhya Pradesh");
  assert.ok(mp, "Madhya Pradesh present from the 452001 test orders");
  assert.ok(mp.customers >= 1 && mp.orders >= 1 && mp.revenue > 0);

  // a Delhi buyer (110001) shows up under Delhi NCR
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const placed = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      items: [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }],
      customer: { name: "Delhi Buyer", phone: "9811100022", address: "1 Connaught Place, Delhi", pincode: "110001" },
      payment: { mode: "upi" },
    }),
  });
  assert.equal(placed.status, 201);
  const after = (await api("/api/admin/footfall", { headers: ADMIN })).data;
  const delhi = after.regions.find((r) => r.region === "Delhi NCR");
  assert.ok(delhi, "Delhi NCR appears after the 110001 order");
  assert.equal(delhi.customers, 1);
  assert.ok(Array.isArray(after.showrooms));
});

test("appearance theme: curated keys only, blank restores the default", async () => {
  assert.equal((await api("/api/content")).data.theme, "heritage");

  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ theme: "champagne" }),
  });
  assert.equal(set.status, 200);
  assert.equal((await api("/api/content")).data.theme, "champagne");

  const dark = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ theme: "midnight" }),
  });
  assert.equal(dark.status, 200);
  assert.equal((await api("/api/content")).data.theme, "midnight");

  const junk = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ theme: "neon-disco" }),
  });
  assert.equal(junk.status, 400);
  assert.match(junk.data.error, /heritage, pearl, champagne, sage, blush, midnight/);

  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ theme: "" }),
  });
  assert.equal((await api("/api/content")).data.theme, "heritage");

  // background picture: URL-validated, blank means none (no default bounce)
  assert.equal((await api("/api/content")).data.backgroundImage, "");
  const setBg = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ backgroundImage: "/api/uploads/marble-texture-x1.jpg" }),
  });
  assert.equal(setBg.status, 200);
  assert.equal((await api("/api/content")).data.backgroundImage, "/api/uploads/marble-texture-x1.jpg");
  const badBg = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ backgroundImage: "not a url" }),
  });
  assert.equal(badBg.status, 400);
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ backgroundImage: "" }),
  });
  assert.equal((await api("/api/content")).data.backgroundImage, "");
});

test("admin can upload media from disk; it serves publicly and sets the hero", async () => {
  const bytes = Buffer.from("fake-mp4-bytes-for-upload-test");
  const up = await fetch(`${BASE}/api/admin/uploads?name=${encodeURIComponent("Hero Clip.MP4")}`, {
    method: "POST",
    headers: { "x-admin-key": "dpj-admin-2026", "content-type": "video/mp4" },
    body: bytes,
  });
  assert.equal(up.status, 201);
  const { url } = await up.json();
  assert.match(url, /^\/api\/uploads\/hero-clip-[a-z0-9]+\.mp4$/);

  // uploaded file is publicly downloadable, byte-for-byte
  const got = await fetch(BASE + url);
  assert.equal(got.status, 200);
  assert.equal((await got.arrayBuffer()).byteLength, bytes.length);

  // usable as the hero video via the content endpoint
  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ heroVideo: url }),
  });
  assert.equal(set.status, 200);
  assert.equal((await api("/api/content")).data.heroVideo, url);
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ heroVideo: "" }),
  });

  // guardrails: wrong extension and missing key are refused
  const badExt = await fetch(`${BASE}/api/admin/uploads?name=x.exe`, {
    method: "POST", headers: { "x-admin-key": "dpj-admin-2026", "content-type": "application/octet-stream" }, body: bytes,
  });
  assert.equal(badExt.status, 400);
  const noKey = await fetch(`${BASE}/api/admin/uploads?name=a.mp4`, {
    method: "POST", headers: { "content-type": "video/mp4" }, body: bytes,
  });
  assert.equal(noKey.status, 401);
});

test("company name and hero wording are admin-editable with defaults on clear", async () => {
  const before = (await api("/api/content")).data;
  assert.equal(before.companyName, "DP Jewellers");
  assert.equal(before.heroLine1, "Light,");

  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ companyName: "DP Jewels & Sons", heroLine1: "Gold,", heroSub: "A new sentence for the hero." }),
  });
  assert.equal(set.status, 200);
  const pub = (await api("/api/content")).data;
  assert.equal(pub.companyName, "DP Jewels & Sons");
  assert.equal(pub.heroLine1, "Gold,");
  assert.equal(pub.heroSub, "A new sentence for the hero.");

  // over-long text refused with the per-field cap
  const long = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ heroLine1: "x".repeat(31) }),
  });
  assert.equal(long.status, 400);
  assert.match(long.data.error, /30 characters/);

  // clearing restores the house default wording
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ companyName: "", heroLine1: "", heroSub: "" }),
  });
  const restored = (await api("/api/content")).data;
  assert.equal(restored.companyName, "DP Jewellers");
  assert.equal(restored.heroLine1, "Light,");
  assert.match(restored.heroSub, /three generations/);
});

test("order thresholds gate checkout (min value and min quantity)", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const item = [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }];

  // raise the minimum value above the cheapest product -> refused with amounts
  const setV = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ minOrderValue: cheap.price.total + 5000 }),
  });
  assert.equal(setV.status, 200);
  const low = await api("/api/orders", { method: "POST", headers: JSONH, body: order(item) });
  assert.equal(low.status, 400);
  assert.match(low.data.error, /minimum order value/i);

  // quantity gate
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ minOrderValue: 0, minOrderQty: 2 }),
  });
  const single = await api("/api/orders", { method: "POST", headers: JSONH, body: order(item) });
  assert.equal(single.status, 400);
  assert.match(single.data.error, /at least 2 items/);

  // back to defaults -> order goes through
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ minOrderQty: 1 }),
  });
  const ok = await api("/api/orders", { method: "POST", headers: JSONH, body: order(item) });
  assert.equal(ok.status, 201);
});

test("delivery area: radius check on shipped orders, off when unset", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const item = [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }];

  // firm at Indore, 9 km radius
  const set = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ deliveryLat: 22.7196, deliveryLng: 75.8577, deliveryRadiusKm: 9 }),
  });
  assert.equal(set.status, 200);

  // no location shared -> refused with guidance
  const noLoc = await api("/api/orders", { method: "POST", headers: JSONH, body: order(item) });
  assert.equal(noLoc.status, 400);
  assert.match(noLoc.data.error, /location access|store pickup/);

  // Delhi (~780 km) -> refused with the distance
  const far = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order(item, { location: { lat: 28.6139, lng: 77.209 } }),
  });
  assert.equal(far.status, 400);
  assert.match(far.data.error, /km away/);

  // 3 km across Indore -> accepted
  const near = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order(item, { location: { lat: 22.7333, lng: 75.88 } }),
  });
  assert.equal(near.status, 201);

  // invalid latitude refused
  const badLat = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ deliveryLat: 999 }),
  });
  assert.equal(badLat.status, 400);

  // blank lat/lng disables the check entirely
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ deliveryLat: "", deliveryLng: "" }),
  });
  const off = await api("/api/orders", { method: "POST", headers: JSONH, body: order(item) });
  assert.equal(off.status, 201);
});

test("customer support channels: editable, validated, blank hides (no default)", async () => {
  // hidden out of the box — no dummy contact details
  const before = (await api("/api/content")).data;
  assert.equal(before.supportPhone, "");
  assert.equal(before.supportEmail, "");

  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({
      supportPhone: "+91 98045 22315",
      supportWhatsapp: "+91 98045 22315",
      supportEmail: "care@dpjewellers.example",
      supportMessage: "Our consultants are online 10 AM to 9 PM, every day.",
    }),
  });
  assert.equal(set.status, 200);
  const pub = (await api("/api/content")).data;
  assert.equal(pub.supportPhone, "+91 98045 22315");
  assert.equal(pub.supportEmail, "care@dpjewellers.example");
  assert.match(pub.supportMessage, /10 AM to 9 PM/);

  // malformed values are refused
  const badMail = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ supportEmail: "not-an-email" }),
  });
  assert.equal(badMail.status, 400);
  assert.match(badMail.data.error, /email/i);
  const badPhone = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ supportPhone: "call me maybe" }),
  });
  assert.equal(badPhone.status, 400);
  const longMsg = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ supportMessage: "x".repeat(501) }),
  });
  assert.equal(longMsg.status, 400);
  assert.match(longMsg.data.error, /500 characters/);

  // blank hides the channel — it must NOT bounce back to any default
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ supportPhone: "", supportWhatsapp: "", supportEmail: "", supportMessage: "" }),
  });
  const cleared = (await api("/api/content")).data;
  assert.equal(cleared.supportPhone, "");
  assert.equal(cleared.supportWhatsapp, "");
  assert.equal(cleared.supportEmail, "");
  assert.equal(cleared.supportMessage, "");
});

test("order policy: cancellation cutoff, customer cancel, returns off at 0", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const cheap = list.items[0];
  const item = [{ slug: cheap.slug, size: cheap.sizes?.[0], qty: 1 }];
  const place = () => api("/api/orders", { method: "POST", headers: JSONH, body: order(item) });

  // fresh order is cancellable (Placed < default cutoff "Shipped") and track says so
  const o1 = (await place()).data;
  const t1 = (await api(`/api/track?orderId=${o1.orderId}&phone=9800000001`)).data;
  assert.equal(t1.cancellable, true);

  // wrong phone is refused, right phone cancels, stock returns
  const wrong = await api(`/api/orders/${o1.orderId}/cancel`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9899999999" }),
  });
  assert.equal(wrong.status, 404);
  const ok = await api(`/api/orders/${o1.orderId}/cancel`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000001" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, "Cancelled");
  const t2 = (await api(`/api/track?orderId=${o1.orderId}&phone=9800000001`)).data;
  assert.equal(t2.status, "Cancelled");
  assert.equal(t2.cancellable, false);
  const again = await api(`/api/orders/${o1.orderId}/cancel`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000001" }),
  });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already cancelled/i);

  // tighten the cutoff to "Confirmed": a confirmed order can no longer be cancelled
  const o2 = (await place()).data;
  await api(`/api/admin/orders/${o2.orderId}/status`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ status: "Confirmed" }),
  });
  const setCut = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ cancelCutoffStatus: "Confirmed" }),
  });
  assert.equal(setCut.status, 200);
  const blocked = await api(`/api/orders/${o2.orderId}/cancel`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000001" }),
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /no longer be cancelled/);
  // ...and the admin can't force it past the cutoff either
  const adminBlocked = await api(`/api/admin/orders/${o2.orderId}/status`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ status: "Cancelled" }),
  });
  assert.equal(adminBlocked.status, 400);

  // widen it to "Delivered": even a shipped order is cancellable again
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ cancelCutoffStatus: "Delivered" }),
  });
  await api(`/api/admin/orders/${o2.orderId}/status`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ status: "Shipped" }),
  });
  const late = await api(`/api/orders/${o2.orderId}/cancel`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000001" }),
  });
  assert.equal(late.status, 200);

  // junk cutoff refused
  const junk = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ cancelCutoffStatus: "Sideways" }),
  });
  assert.equal(junk.status, 400);

  // return window 0 disables returns entirely
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ returnWindowDays: 0 }),
  });
  const noReturns = await api("/api/returns", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({ orderId: o1.orderId, phone: "9800000001", slug: cheap.slug, type: "return", reason: "Changed my mind" }),
  });
  assert.equal(noReturns.status, 400);
  assert.match(noReturns.data.error, /not accepted/);

  // policy message is editable copy that may stay blank
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ returnPolicyMessage: "Unworn pieces with the HUID tag intact only." }),
  });
  assert.match((await api("/api/content")).data.returnPolicyMessage, /HUID tag/);
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ returnPolicyMessage: "" }),
  });
  assert.equal((await api("/api/content")).data.returnPolicyMessage, "");

  // restore defaults for later tests
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ cancelCutoffStatus: "Shipped", returnWindowDays: 15 }),
  });
});

test("PDP product-details toggles: on by default, admin-switchable, 0/1 only", async () => {
  const KEYS = ["pdpShowGstNote", "pdpShowRateNote", "pdpShowLockNote", "pdpShowWhatsapp", "pdpShowCallback", "pdpShowVisit"];
  const cfg = (await api("/api/config")).data;
  for (const k of KEYS) assert.equal(cfg[k], 1, `${k} should default to 1`);

  const off = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ pdpShowGstNote: 0, pdpShowWhatsapp: 0 }),
  });
  assert.equal(off.status, 200);
  const after = (await api("/api/config")).data;
  assert.equal(after.pdpShowGstNote, 0);
  assert.equal(after.pdpShowWhatsapp, 0);

  const bad = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ pdpShowGstNote: 2 }),
  });
  assert.equal(bad.status, 400);

  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ pdpShowGstNote: 1, pdpShowWhatsapp: 1 }),
  });
});

test("site-wide discount: reprices catalogue, orders and invoice; off restores", async () => {
  const { data: list } = await api("/api/products?sort=price-asc&limit=1");
  const slug = list.items[0].slug;
  const before = (await api(`/api/products/${slug}`)).data.product.price;
  assert.equal(before.discountPct, 0);

  // 10% site-wide sale
  const set = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ siteDiscountOn: 1, siteDiscountPct: 10 }),
  });
  assert.equal(set.status, 200);
  const sale = (await api(`/api/products/${slug}`)).data.product.price;
  assert.equal(sale.discountPct, 10);
  assert.equal(sale.mrpTotal, before.total); // strike-through shows the old price
  assert.ok(sale.total < before.total);
  assert.equal(sale.discountValue, Math.round(sale.subtotal * 0.1));

  // an order placed during the sale pays the discounted price, invoice adds up
  const placed = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug, size: list.items[0].sizes?.[0], qty: 1 }]),
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.data.payable ?? placed.data.total, sale.total);

  // toggling off (percent kept) restores full pricing
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ siteDiscountOn: 0 }),
  });
  const after = (await api(`/api/products/${slug}`)).data.product.price;
  assert.equal(after.discountPct, 0);
  assert.equal(after.total, before.total);
  assert.equal((await api("/api/config")).data.siteDiscountPct, 10); // kept

  // guard rails: >75% refused
  const tooBig = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ siteDiscountPct: 80 }),
  });
  assert.equal(tooBig.status, 400);
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ siteDiscountPct: 0 }),
  });
});

test("call-back requests: stored, deduped, surfaced to admin, closeable", async () => {
  const { data: list } = await api("/api/products?limit=1");
  const slug = list.items[0].slug;

  const badPhone = await api("/api/callbacks", {
    method: "POST", headers: JSONH, body: JSON.stringify({ slug, phone: "12345" }),
  });
  assert.equal(badPhone.status, 400);
  const badSlug = await api("/api/callbacks", {
    method: "POST", headers: JSONH, body: JSON.stringify({ slug: "no-such-piece", phone: "9822200011" }),
  });
  assert.equal(badSlug.status, 400);

  const ok = await api("/api/callbacks", {
    method: "POST", headers: JSONH, body: JSON.stringify({ slug, phone: "9822200011", name: "Callback Tester" }),
  });
  assert.equal(ok.status, 201);
  const dupe = await api("/api/callbacks", {
    method: "POST", headers: JSONH, body: JSON.stringify({ slug, phone: "9822200011" }),
  });
  assert.equal(dupe.status, 409);

  // visible in the admin list and on the dashboard counter
  const rows = (await api("/api/admin/callbacks", { headers: ADMIN })).data;
  const mine = rows.find((r) => r.id === ok.data.id);
  assert.equal(mine.status, "New");
  assert.equal(mine.phone, "9822200011");
  assert.equal(mine.slug, slug);
  const summary = (await api("/api/admin/summary", { headers: ADMIN })).data;
  assert.ok(summary.callbacksNew >= 1);

  // mark as called — once
  const done = await api(`/api/admin/callbacks/${ok.data.id}`, { method: "PATCH", headers: ADMIN });
  assert.equal(done.status, 200);
  assert.equal(done.data.request.status, "Called");
  const twice = await api(`/api/admin/callbacks/${ok.data.id}`, { method: "PATCH", headers: ADMIN });
  assert.equal(twice.status, 400);

  // once called, the same customer may ask again
  const again = await api("/api/callbacks", {
    method: "POST", headers: JSONH, body: JSON.stringify({ slug, phone: "9822200011" }),
  });
  assert.equal(again.status, 201);
  await api(`/api/admin/callbacks/${again.data.id}`, { method: "PATCH", headers: ADMIN });

  // admin auth required
  const noKey = await api("/api/admin/callbacks");
  assert.equal(noKey.status, 401);
});

test("product image gallery: admin sets 1-8 images, first is the cover", async () => {
  const rows = (await api("/api/admin/products", { headers: ADMIN })).data;
  const target = rows.find((r) => r.slug === "meera-classic-band") || rows[0];
  assert.ok(Array.isArray(target.images) && target.images.length >= 1);
  const original = target.images;

  const gallery = [
    "/api/uploads/meera-side-abc123.jpg",
    "https://images.unsplash.com/photo-1601121141461?q=80",
    original[0],
  ];
  const set = await api(`/api/admin/products/${target.slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ images: gallery }),
  });
  assert.equal(set.status, 200);
  const pub = (await api(`/api/products/${target.slug}`)).data.product;
  assert.deepEqual(pub.images, gallery);

  // guard rails: empty list, a bad URL, and more than 8 are refused
  const empty = await api(`/api/admin/products/${target.slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ images: [] }),
  });
  assert.equal(empty.status, 400);
  const bad = await api(`/api/admin/products/${target.slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ images: ["not a url"] }),
  });
  assert.equal(bad.status, 400);
  const many = await api(`/api/admin/products/${target.slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ images: Array(9).fill("/img/x.jpg") }),
  });
  assert.equal(many.status, 400);
  assert.deepEqual((await api(`/api/products/${target.slug}`)).data.product.images, gallery);

  // an order line uses the (new) cover image
  const { data: full } = await api(`/api/products/${target.slug}`);
  const placed = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: target.slug, size: full.product.sizes?.[0], qty: 1 }]),
  });
  assert.equal(placed.status, 201);

  // restore the original gallery
  await api(`/api/admin/products/${target.slug}`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ images: original }),
  });
});

test("header & footer are admin-editable; empty lists restore defaults", async () => {
  const before = (await api("/api/content")).data;
  assert.equal(before.navLinks.length, 5);
  assert.equal(before.footerColumns.length, 3);
  assert.match(before.footerBlurb, /Three generations/);

  // custom nav + footer
  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({
      navLinks: [
        { label: "Home", path: "/" },
        { label: "Bridal", path: "/shop?occasion=wedding" },
        { label: "Blog", path: "https://blog.dpjewellers.example" },
      ],
      footerBlurb: "Jewellery priced on the day's rate, always.",
      footerColumns: [
        { title: "Quick links", links: [{ label: "Track", path: "/track" }, { label: "Schemes", path: "/gold-scheme" }] },
      ],
    }),
  });
  assert.equal(set.status, 200);
  const pub = (await api("/api/content")).data;
  assert.equal(pub.navLinks.length, 3);
  assert.equal(pub.navLinks[2].path, "https://blog.dpjewellers.example");
  assert.equal(pub.footerColumns[0].title, "Quick links");
  assert.match(pub.footerBlurb, /always/);

  // guard rails
  const tooMany = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ navLinks: Array(8).fill({ label: "X", path: "/" }) }),
  });
  assert.equal(tooMany.status, 400);
  const badPath = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ navLinks: [{ label: "Bad", path: "javascript:alert(1)" }] }),
  });
  assert.equal(badPath.status, 400);
  const noTitle = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ footerColumns: [{ title: "", links: [{ label: "A", path: "/" }] }] }),
  });
  assert.equal(noTitle.status, 400);

  // empty lists restore the standard layout
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ navLinks: [], footerColumns: [], footerBlurb: "" }),
  });
  const restored = (await api("/api/content")).data;
  assert.equal(restored.navLinks.length, 5);
  assert.equal(restored.footerColumns.length, 3);
  assert.match(restored.footerBlurb, /Three generations/);

  // header and footer background pictures: URL-validated, blank = plain
  assert.equal(restored.headerBgImage, "");
  assert.equal(restored.footerBgImage, "");
  const setBgs = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({
      headerBgImage: "/api/uploads/silk-weave-h1.jpg",
      footerBgImage: "/api/uploads/silk-weave-f1.jpg",
    }),
  });
  assert.equal(setBgs.status, 200);
  const withBgs = (await api("/api/content")).data;
  assert.equal(withBgs.headerBgImage, "/api/uploads/silk-weave-h1.jpg");
  assert.equal(withBgs.footerBgImage, "/api/uploads/silk-weave-f1.jpg");
  const badBg = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ headerBgImage: "not a url" }),
  });
  assert.equal(badBg.status, 400);
  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ headerBgImage: "", footerBgImage: "" }),
  });
  const plain = (await api("/api/content")).data;
  assert.equal(plain.headerBgImage, "");
  assert.equal(plain.footerBgImage, "");
});

test("showrooms: admin-managed branches drive stores, appointments and pickup", async () => {
  const initial = (await api("/api/stores")).data;
  assert.equal(initial.stores.length, 3);
  assert.equal(initial.stores[0].key, "indore-palasia");

  // replace the list with two custom branches (keys derive from names)
  const set = await api("/api/admin/stores", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ stores: [
      { name: "Dewas - Station Road", address: "3 Station Road, Dewas 455001", hours: "10:00 am - 8:00 pm", phone: "+91 727 224 4556" },
      { name: "Ratlam - Do Batti", address: "9 Do Batti Chowk, Ratlam 457001", hours: "", phone: "" },
    ] }),
  });
  assert.equal(set.status, 200);
  assert.equal(set.data.stores.length, 2);
  assert.equal(set.data.stores[0].key, "dewas-station-road");

  const live = (await api("/api/stores")).data.stores;
  assert.equal(live.length, 2);

  // appointments accept the new branch and reject the removed one
  const when = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const booked = await api("/api/appointments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ store: "ratlam-do-batti", date: when, slot: "2:00 pm", name: "Branch Test", phone: "9800000031" }),
  });
  assert.equal(booked.status, 201);
  assert.equal(booked.data.storeName, "Ratlam - Do Batti");
  const gone = await api("/api/appointments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ store: "indore-palasia", date: when, slot: "2:00 pm", name: "Branch Test", phone: "9800000031" }),
  });
  assert.equal(gone.status, 400);

  // validation: a branch without an address is refused, list unchanged
  const bad = await api("/api/admin/stores", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ stores: [{ name: "Nameless", address: "" }] }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await api("/api/stores")).data.stores.length, 2);

  // empty list restores the standard branches
  const restore = await api("/api/admin/stores", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ stores: [] }),
  });
  assert.equal(restore.status, 200);
  const back = (await api("/api/stores")).data.stores;
  assert.equal(back.length, 3);
  assert.equal(back[2].key, "ujjain-freeganj");
});

test("emi plans: bank-partner schemes are admin-managed, empty = simple line", async () => {
  const fresh = (await api("/api/config")).data;
  assert.deepEqual(fresh.emiPlans, []);
  assert.equal(fresh.pdpShowEmi, 1);

  const set = await api("/api/admin/emi-plans", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ plans: [
      { bank: "HDFC Bank", months: 12, ratePct: 0, minAmount: 0 },
      { bank: "ICICI Bank", months: 18, ratePct: 13.5, minAmount: 50000 },
    ] }),
  });
  assert.equal(set.status, 200);
  assert.equal(set.data.plans.length, 2);
  assert.equal(set.data.plans[1].ratePct, 13.5);

  const live = (await api("/api/config")).data.emiPlans;
  assert.equal(live.length, 2);
  assert.equal(live[0].bank, "HDFC Bank");

  // validation failures leave the list untouched
  const noBank = await api("/api/admin/emi-plans", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ plans: [{ bank: "", months: 12 }] }),
  });
  assert.equal(noBank.status, 400);
  const badTenure = await api("/api/admin/emi-plans", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ plans: [{ bank: "Axis", months: 48 }] }),
  });
  assert.equal(badTenure.status, 400);
  assert.equal((await api("/api/config")).data.emiPlans.length, 2);

  // the EMI line itself can be hidden via the pdp toggle
  const hide = await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ pdpShowEmi: 0 }),
  });
  assert.equal(hide.status, 200);
  assert.equal((await api("/api/config")).data.pdpShowEmi, 0);
  await api("/api/admin/config", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ pdpShowEmi: 1 }),
  });

  // empty list clears back to the simple interest-free line
  const clear = await api("/api/admin/emi-plans", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ plans: [] }),
  });
  assert.equal(clear.status, 200);
  assert.deepEqual((await api("/api/config")).data.emiPlans, []);
});

test("gold scheme plans: admin-managed, keys stable, referenced plans protected", async () => {
  const initial = (await api("/api/schemes")).data;
  assert.equal(initial.length, 2);
  assert.equal(initial[0].key, "swarna-11-1");

  // add a third plan and rename an existing one (key must survive the rename)
  const withNew = await api("/api/admin/scheme-variants", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ variants: [
      { key: "swarna-11-1", name: "Swarna Plus 11+1", tenureMonths: 11, minMonthly: 2000, bonus: "12th instalment on us", blurb: "Eleven pay, twelve accrue." },
      { key: "flexi-24", name: "Flexi Gold 24", tenureMonths: 24, minMonthly: 1000, bonus: "Making charges waived up to 50% at redemption", blurb: "Two light years of gold." },
      { name: "Akshaya 12", tenureMonths: 12, minMonthly: 3000, bonus: "5% bonus grams at redemption", blurb: "One festive year of savings." },
    ] }),
  });
  assert.equal(withNew.status, 200);
  assert.equal(withNew.data.variants.length, 3);
  assert.equal(withNew.data.variants[0].key, "swarna-11-1");
  assert.equal(withNew.data.variants[0].name, "Swarna Plus 11+1");
  assert.equal(withNew.data.variants[2].key, "akshaya-12");

  // a customer enrols on the new plan (min monthly enforced from the plan)
  const tooLow = await api("/api/schemes/enroll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ variant: "akshaya-12", monthlyAmount: 2000, acceptTerms: true, customer: { name: "Plan Test", phone: "9800000041" } }),
  });
  assert.equal(tooLow.status, 400);
  const enrolled = await api("/api/schemes/enroll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ variant: "akshaya-12", monthlyAmount: 3000, acceptTerms: true, customer: { name: "Plan Test", phone: "9800000041" } }),
  });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.data.variantName, "Akshaya 12");
  assert.equal(enrolled.data.tenureMonths, 12);

  // the referenced plan can no longer be removed - neither directly...
  const dropIt = await api("/api/admin/scheme-variants", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ variants: [
      { key: "swarna-11-1", name: "Swarna 11+1", tenureMonths: 11, minMonthly: 2000 },
      { key: "flexi-24", name: "Flexi Gold 24", tenureMonths: 24, minMonthly: 1000 },
    ] }),
  });
  assert.equal(dropIt.status, 400);
  assert.match(dropIt.data.error, /akshaya-12/);
  // ...nor via restore-to-standard while a scheme still references it
  const restore = await api("/api/admin/scheme-variants", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ variants: [] }),
  });
  assert.equal(restore.status, 400);
  assert.equal((await api("/api/schemes")).data.length, 3);

  // validation: tenure out of range refused
  const bad = await api("/api/admin/scheme-variants", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ variants: [{ name: "Century", tenureMonths: 90, minMonthly: 1000 }] }),
  });
  assert.equal(bad.status, 400);

  // put the standard names back (keeping the referenced third plan)
  const settle = await api("/api/admin/scheme-variants", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ variants: [
      { key: "swarna-11-1", name: "Swarna 11+1", tenureMonths: 11, minMonthly: 2000, bonus: "12th instalment paid by DP Jewellers at redemption", blurb: "Pay 11 monthly instalments; the house adds the 12th. Redeem against any purchase." },
      { key: "flexi-24", name: "Flexi Gold 24", tenureMonths: 24, minMonthly: 1000, bonus: "Making charges waived up to 50% at redemption", blurb: "A longer, lighter commitment that accrues grams every month for two years." },
      { key: "akshaya-12", name: "Akshaya 12", tenureMonths: 12, minMonthly: 3000, bonus: "5% bonus grams at redemption", blurb: "One festive year of savings." },
    ] }),
  });
  assert.equal(settle.status, 200);
});

test("discount rules engine: conditions, priority, making target, audiences", async () => {
  await api("/api/admin/config", { method: "PATCH", headers: ADMIN, body: JSON.stringify({ siteDiscountOn: 0 }) });
  const bare = (await api("/api/products/aurelia-solitaire-ring")).data.product.price;
  assert.equal(bare.discountPct, 0);

  // 1) making-charge rule, gold only — reduces making, leaves jewellery GST full
  const setOne = await api("/api/admin/discount-rules", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ rules: [
      { name: "Festival making offer", pct: 50, target: "making", metal: "gold" },
    ] }),
  });
  assert.equal(setOne.status, 200);
  const making = (await api("/api/products/aurelia-solitaire-ring")).data.product.price;
  assert.equal(making.discountBase, "making");
  assert.equal(making.discountLabel, "Festival making offer");
  assert.equal(making.discountRatePct, 50, "configured rate rides along for the break-up line");
  assert.equal(making.discountValue, Math.round(bare.makingCharges * 0.5));
  assert.equal(making.taxable, bare.subtotal - making.discountValue);
  assert.equal(making.gstDetail.onJewellery, bare.gstDetail.onJewellery);
  assert.equal(making.gstDetail.onMaking, Math.round(bare.gstDetail.onMaking / 2));

  // 2) a higher-priority whole-price rule wins even at a smaller saving
  await api("/api/admin/discount-rules", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ rules: [
      { name: "Festival making offer", pct: 50, target: "making", metal: "gold" },
      { name: "Golden hour", pct: 5, target: "price", priority: 10 },
    ] }),
  });
  const prio = (await api("/api/products/aurelia-solitaire-ring")).data.product.price;
  assert.equal(prio.discountLabel, "Golden hour");
  assert.equal(prio.discountPct, 5);

  // 3) purity + date-window conditions exclude
  await api("/api/admin/discount-rules", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ rules: [
      { name: "22K only", pct: 10, purity: "22K" },
      { name: "Ended sale", pct: 20, endsAt: "2020-01-01" },
    ] }),
  });
  const excluded = (await api("/api/products/aurelia-solitaire-ring")).data.product.price;
  assert.equal(excluded.discountPct, 0); // aurelia is 18K; the 20% sale is over
  const meera = (await api("/api/products/meera-classic-band")).data.product.price;
  assert.equal(meera.discountLabel, "22K only"); // meera is 22K

  // 4) audience rules: anonymous browsing untouched, billing applies them
  await api("/api/admin/discount-rules", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ rules: [
      { name: "Scheme circle", pct: 12, audience: "scheme" },
    ] }),
  });
  assert.equal((await api("/api/products/aurelia-solitaire-ring")).data.product.price.discountPct, 0);

  const schemePhone = "9800000061";
  const enrolled = await api("/api/schemes/enroll", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({ variant: "flexi-24", monthlyAmount: 1500, acceptTerms: true, customer: { name: "Scheme Buyer", phone: schemePhone } }),
  });
  assert.equal(enrolled.status, 201);
  const schemeOrder = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: "aurelia-solitaire-ring", qty: 1, size: "12" }], {
      customer: { name: "Scheme Buyer", phone: schemePhone, address: "9 Scheme Lane, Indore", pincode: "452001" },
    }),
  });
  assert.equal(schemeOrder.status, 201);
  const allOrders = (await api("/api/admin/orders", { headers: ADMIN })).data.orders;
  const line = allOrders.find((o) => o.orderId === schemeOrder.data.orderId).lines[0];
  assert.equal(line.unitBreak.taxable, bare.subtotal - Math.round(bare.subtotal * 0.12));

  // a first-time stranger gets no scheme discount at billing
  const plainOrder = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: "aurelia-solitaire-ring", qty: 1, size: "12" }], {
      customer: { name: "Plain Buyer", phone: "9800000062", address: "9 Plain Lane, Indore", pincode: "452001" },
    }),
  });
  assert.equal(plainOrder.status, 201);
  const plainLine = (await api("/api/admin/orders", { headers: ADMIN })).data.orders
    .find((o) => o.orderId === plainOrder.data.orderId).lines[0];
  assert.equal(plainLine.unitBreak.taxable, bare.subtotal);

  // validation + cleanup
  const bad = await api("/api/admin/discount-rules", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ rules: [{ name: "Too deep", pct: 90 }] }),
  });
  assert.equal(bad.status, 400);
  const cleared = await api("/api/admin/discount-rules", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ rules: [] }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await api("/api/products/aurelia-solitaire-ring")).data.product.price.discountPct, 0);
});

test("placing an order auto-creates the customer account, address on file", async () => {
  const phone = "9800000071";
  assert.equal((await api(`/api/admin/customers/${phone}`, { headers: ADMIN })).status, 404);

  const placed = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: "aurelia-solitaire-ring", qty: 1, size: "12" }], {
      customer: { name: "Auto Account", phone, address: "42 Auto Lane, Indore", pincode: "452001", email: "auto@test.in" },
    }),
  });
  assert.equal(placed.status, 201);

  const profile = (await api(`/api/admin/customers/${phone}`, { headers: ADMIN })).data;
  assert.ok(profile.account, "account was auto-created");
  assert.equal(profile.account.email, "auto@test.in");
  assert.equal(profile.account.addresses.length, 1);
  assert.equal(profile.account.addresses[0].line, "42 Auto Lane, Indore");
  assert.equal(profile.account.addresses[0].isDefault, true);

  // same address never duplicates; a different one is kept as well
  await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: "aurelia-solitaire-ring", qty: 1, size: "12" }], {
      customer: { name: "Auto Account", phone, address: "42 Auto Lane, Indore", pincode: "452001" },
    }),
  });
  await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: order([{ slug: "aurelia-solitaire-ring", qty: 1, size: "12" }], {
      customer: { name: "Auto Account", phone, address: "7 Second Street, Bhopal", pincode: "462011" },
    }),
  });
  const p2 = (await api(`/api/admin/customers/${phone}`, { headers: ADMIN })).data;
  assert.equal(p2.account.addresses.length, 2);

  // OTP sign-in lands in the SAME auto-created account
  const otp = (await api("/api/auth/otp", { method: "POST", headers: JSONH, body: JSON.stringify({ phone }) })).data.demoOtp;
  const verified = (await api("/api/auth/verify", { method: "POST", headers: JSONH, body: JSON.stringify({ phone, otp }) })).data;
  assert.equal(verified.customer.name, "Auto Account");
  assert.equal(verified.customer.addresses.length, 2);

  // tracking is product-wise: each line carries its slug and money fields
  const track = (await api(`/api/track?orderId=${placed.data.orderId}&phone=${phone}`)).data;
  assert.equal(track.lines[0].slug, "aurelia-solitaire-ring");
  assert.ok(track.lines[0].unitPrice > 0);
  assert.ok(track.lines[0].lineTotal > 0);
});

test("category promotion banners: validated, ordered, blank list hides the marquee", async () => {
  assert.deepEqual((await api("/api/content")).data.promoBanners, []);

  const set = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ promoBanners: [
      { image: "/api/uploads/diwali-rings.jpg", category: "rings", alt: "Diwali sale on rings", hMobile: 120, hDesktop: 220 },
      { image: "/api/uploads/silver-fest.jpg", category: "old-sarees", on: false },
    ] }),
  });
  assert.equal(set.status, 200);
  const live = (await api("/api/content")).data.promoBanners;
  assert.equal(live.length, 2);
  assert.equal(live[0].category, "rings");
  assert.equal(live[0].hDesktop, 220);
  assert.equal(live[1].on, false);

  const badImg = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ promoBanners: [{ image: "not a url", category: "rings" }] }),
  });
  assert.equal(badImg.status, 400);
  const badHeight = await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({ promoBanners: [{ image: "/api/uploads/x.jpg", hDesktop: 2000 }] }),
  });
  assert.equal(badHeight.status, 400);

  await api("/api/admin/content", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ promoBanners: [] }),
  });
  assert.deepEqual((await api("/api/content")).data.promoBanners, []);
});

test("phone-first tracking lists every order product-wise, no order id needed", async () => {
  assert.equal((await api("/api/track/my?phone=12345")).status, 400);
  const empty = (await api("/api/track/my?phone=9899999997")).data;
  assert.deepEqual(empty.orders, []);
  const mine = (await api("/api/track/my?phone=9800000001")).data.orders;
  assert.ok(mine.length >= 1);
  const o = mine[0];
  assert.ok(o.orderId.startsWith("DPJ"));
  assert.ok(o.lines.length >= 1 && o.lines[0].slug && o.lines[0].image);
  assert.ok(typeof o.lines[0].lineTotal === "number");
  assert.ok(typeof o.cancellable === "boolean");
  assert.ok(o.total > 0 && o.status);
  // gender is now an editable profile field
  const otp = (await api("/api/auth/otp", { method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000001" }) })).data.demoOtp;
  const { token } = (await api("/api/auth/verify", { method: "POST", headers: JSONH, body: JSON.stringify({ phone: "9800000001", otp }) })).data;
  const upd = await api("/api/me", {
    method: "PATCH", headers: { "x-auth-token": token, "content-type": "application/json" },
    body: JSON.stringify({ gender: "Female" }),
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.gender, "Female");
});

test("mega-menu data: live counts and starting-at prices per category", async () => {
  const { menu } = (await api("/api/menu")).data;
  assert.ok(menu.length >= 3, "categories with published pieces appear");
  const rings = menu.find((m) => m.key === "rings");
  assert.ok(rings, "rings category present");
  assert.ok(rings.count >= 1);
  assert.ok(rings.image && rings.label === "Rings");
  assert.ok(rings.occasions.length >= 1 && rings.occasions[0].count >= 1);
  assert.ok(rings.metals.length >= 1);
  const gold = rings.metals.find((x) => x.type === "gold");
  assert.ok(gold && gold.from > 0, "gold starting-at price computed");
  assert.ok(rings.purities.every((x) => x.from > 0));
  // starting-at equals the cheapest live-priced piece in that slice
  const cheapest = (await api("/api/products?category=rings&metal=gold&sort=price-asc&limit=1")).data.items[0];
  assert.equal(gold.from, cheapest.price.total);
});

test("occasion tags: normalised on create, editable via PATCH, listed for admin", async () => {
  // messy input → trimmed, lowercased, deduped
  const created = await api("/api/admin/products", {
    method: "POST", headers: ADMIN,
    body: JSON.stringify({
      name: "Occasion Test Hoop", category: "earrings", metalType: "gold", purity: "18K",
      grossWeight: 3.1, netWeight: 3.0, making: { basis: "perGram", value: 650 },
      occasion: [" Party ", "party", "GIFTING"],
    }),
  });
  assert.equal(created.status, 201);
  const pdp = await api("/api/products/occasion-test-hoop");
  assert.deepEqual(pdp.data.product.occasion, ["party", "gifting"]);

  // the tags flow into the mega-menu counts for that category
  const menu1 = (await api("/api/menu")).data.menu.find((m) => m.key === "earrings");
  assert.ok(menu1.occasions.some((o) => o.key === "party" && o.count >= 1));

  // retag via PATCH; the admin listing carries the tags
  const patched = await api("/api/admin/products/occasion-test-hoop", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ occasion: ["Office", "wedding "] }),
  });
  assert.equal(patched.status, 200);
  const listed = (await api("/api/admin/products", { headers: ADMIN })).data
    .find((p) => p.slug === "occasion-test-hoop");
  assert.deepEqual(listed.occasion, ["office", "wedding"]);

  // a piece can never lose its last tag
  const empty = await api("/api/admin/products/occasion-test-hoop", {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ occasion: [] }),
  });
  assert.equal(empty.status, 400);

  // CSV template ships canonical example tags; export round-trips the column
  const template = await fetch(`${BASE}/api/admin/export/template.csv?key=dpj-admin-2026`).then((r) => r.text());
  assert.ok(template.includes("daily;office") && template.includes("wedding;gifting"));
  const exported = await fetch(`${BASE}/api/admin/export/catalogue.csv?key=dpj-admin-2026`).then((r) => r.text());
  assert.ok(exported.split(/\r?\n/).some((l) => l.includes("occasion-test-hoop") && l.includes("office;wedding")));
});

test("order console: filters, pagination, notes, open-box photos and COD collection", async () => {
  // cheapest silver piece that is actually buyable (an earlier test sells one out)
  const silvers = (await api("/api/products?metal=silver&sort=price-asc")).data.items;
  let cheap = null;
  for (const s of silvers) {
    const pdp = (await api(`/api/products/${s.slug}`)).data.product;
    if (pdp.stock === null || pdp.stock > 0) { cheap = s; break; }
  }
  assert.ok(cheap, "a buyable silver piece exists");
  const placed = await api("/api/orders", {
    method: "POST", headers: JSONH,
    body: JSON.stringify({
      items: [{ slug: cheap.slug, qty: 1 }],
      customer: { name: "Console Buyer", phone: "9800000077", address: "7 Console Rd, Indore", pincode: "452001" },
      payment: { mode: "cod" },
      location: { lat: 22.7196, lng: 75.8577 },
    }),
  });
  assert.ok(placed.data.orderId, `order failed: ${JSON.stringify(placed.data)}`);
  const oid = placed.data.orderId;

  // filters narrow server-side; pagination meta is honest
  const one = await api(`/api/admin/orders?q=${oid.slice(-6)}&page=1&limit=5`, { headers: ADMIN });
  assert.equal(one.data.orders.length, 1);
  assert.equal(one.data.orders[0].orderId, oid);
  assert.equal(one.data.meta.total, 1);
  assert.ok(one.data.meta.counts.Placed >= 1, "counts cover all orders");
  assert.deepEqual(one.data.orders[0].location, { lat: 22.7196, lng: 75.8577, source: "gps" });
  const paged = await api("/api/admin/orders?page=1&limit=2", { headers: ADMIN });
  assert.equal(paged.data.orders.length, 2);
  assert.ok(paged.data.meta.totalPages >= 2);
  const custFiltered = await api("/api/admin/orders?customer=console%20buyer", { headers: ADMIN });
  assert.ok(custFiltered.data.orders.some((o) => o.orderId === oid));

  // an illegal transition names the legal ones
  const bad = await api(`/api/admin/orders/${oid}/status`, {
    method: "PATCH", headers: ADMIN, body: JSON.stringify({ status: "Returned" }),
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.includes("Legal next statuses"));

  // Delivered with a note + photos: COD flips to paid, photos stamped, timeline enriched
  const done = await api(`/api/admin/orders/${oid}/status`, {
    method: "PATCH", headers: ADMIN,
    body: JSON.stringify({
      status: "Delivered",
      note: "Handed over at the door",
      deliveryPhotos: [{ url: "/api/uploads/openbox-1.png" }, { url: "not a url" }],
    }),
  });
  assert.equal(done.status, 200);
  const o = done.data.order;
  assert.equal(o.status, "Delivered");
  assert.equal(o.payment.status, "paid");
  assert.equal(o.deliveryPhotos.length, 1, "invalid photo URL dropped, valid one kept");
  assert.ok(o.deliveryPhotos[0].uploadedAt && o.deliveryPhotos[0].uploadedBy === "admin");
  const last = o.statusTimeline[o.statusTimeline.length - 1];
  assert.equal(last.note, "Handed over at the door");
  assert.equal(last.paymentCollected, true);
  assert.equal(last.photoCount, 1);
  assert.ok(o.invoice, "invoice raised once COD is collected");
  assert.deepEqual(o.nextStatuses, ["Returned"]);

  // export: new columns plus the summary block
  const csv = await fetch(`${BASE}/api/admin/export/orders.csv?key=dpj-admin-2026`).then((r) => r.text());
  assert.ok(csv.split(/\r?\n/)[0].includes("email"));
  assert.ok(csv.includes("Total orders"));
});

test("customer directory export: columns, rows and summary block", async () => {
  const csv = await fetch(`${BASE}/api/admin/export/customers.csv?key=dpj-admin-2026`).then((r) => r.text());
  const lines = csv.split(/\r?\n/);
  assert.ok(lines[0].includes("lifetimeValue") && lines[0].includes("tier"));
  assert.ok(csv.includes("9800000077"), "console buyer appears");
  assert.ok(csv.includes("Total customers"));
  assert.ok(csv.includes("Registered accounts"));
  const noKey = await fetch(`${BASE}/api/admin/export/customers.csv`);
  assert.equal(noKey.status, 401);
});

test("rate-history report: filtered CSV with summary and live rates", async () => {
  const all = await fetch(`${BASE}/api/admin/export/rates.csv?key=dpj-admin-2026`).then((r) => r.text());
  assert.ok(all.split(/\r?\n/)[0].includes("publishedAt"));
  assert.ok(all.includes("Changes in report"));
  assert.ok(all.includes("Current live rates"));
  const goldOnly = await fetch(`${BASE}/api/admin/export/rates.csv?key=dpj-admin-2026&metal=gold&days=30`).then((r) => r.text());
  assert.ok(goldOnly.includes("last 30 days"));
  assert.ok(!goldOnly.split("Current live rates")[0].split(/\r?\n/).slice(1).some((l) => l.startsWith("") && l.includes(",silver,")), "silver rows filtered out");
  const noKey = await fetch(`${BASE}/api/admin/export/rates.csv`);
  assert.equal(noKey.status, 401);
});
