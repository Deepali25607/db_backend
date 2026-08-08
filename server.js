const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { computePrice } = require("./pricing");
const { products: seedProducts, categories } = require("./data/products");
const { db, save, storage } = require("./store");
const providers = require("./providers");

// Catalogue lives in the persistent store so the admin can edit it
// (BRD FR-ADM-03). Seeded from data/products.js on first boot.
if (!Array.isArray(db.products) || db.products.length === 0) {
  db.products = structuredClone(seedProducts);
  save();
}
const products = db.products; // live reference — mutations persist via save()
const published = () => products.filter((p) => p.published !== false);

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.DPJ_ADMIN_KEY || "dpj-admin-2026";

// Webhook signature verification needs the exact raw bytes, so this route's
// body parser is mounted BEFORE the JSON parser (which then skips it).
app.use("/api/payments/webhook", express.raw({ type: "*/*", limit: "200kb" }));
app.use(express.json({ limit: "200kb" })); // no legitimate payload is larger

// Baseline security headers (helmet-lite, no dependency).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // geolocation=(self): the delivery-area check asks for the customer's
  // location at checkout; camera/microphone stay blocked.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  next();
});

// Configurable business rules (BRD FR-ADM-08). Defaults below; overrides
// persist in db.config and are editable from the admin Settings tab. The
// merged object is shared by reference, so edits apply immediately.
const DEFAULT_CONFIG = {
  codCeiling: 50000,
  panThreshold: 200000,
  minOrderValue: 0, // 0 = no minimum
  minOrderQty: 1, // 1 = no minimum
  deliveryLat: null, // firm location — blank disables the radius check
  deliveryLng: null,
  deliveryRadiusKm: 9,

  priceLockMinutes: 30,
  emiMonths: 12,
  rateGuardPct: 20, // margin guard: proposals may not move a rate more than ±20%
  rateMakerChecker: 1, // 1 = rate changes need a second person's approval; 0 = publish instantly
  returnWindowDays: 15, // 0 = returns disabled entirely
  cancelCutoffStatus: "Shipped", // first status at which an order can no longer be cancelled

  // Discounts (Settings): site-wide markdown; the percent is kept when toggled off
  siteDiscountOn: 0,
  siteDiscountPct: 0,

  // PDP "Product details" toggles — each shows/hides one element on the page
  pdpShowGstNote: 1, // "Inclusive of GST" in the price note
  pdpShowRateNote: 1, // "computed at today's <purity> rate of ₹X/g"
  pdpShowLockNote: 1, // "price locked for N min once in bag"
  pdpShowWhatsapp: 1, // "Enquire on WhatsApp" (also needs the support WhatsApp number)
  pdpShowCallback: 1, // "Request a call back"
  pdpShowVisit: 1, // "Book a showroom visit for this piece"
  pdpShowEmi: 1, // the "EMI from ₹X/month" line
  verificationThreshold: 150000, // orders at/above get a verification call hold (FR-OMS-03/04)
  lowStockThreshold: 3,
  storeName: "DP Jewellers",
};
const config = Object.assign({}, DEFAULT_CONFIG, db.config || {});
db.config = config;
save();

// What the Settings tab may change, with guard rails.
const CONFIG_FIELDS = [
  { key: "codCeiling", label: "COD ceiling (₹)", min: 0, max: 200000 },
  { key: "minOrderValue", label: "Minimum order value (₹, 0 = off)", min: 0, max: 500000 },
  { key: "minOrderQty", label: "Minimum order quantity (items)", min: 1, max: 20 },
  { key: "panThreshold", label: "PAN mandatory from (₹)", min: 50000, max: 1000000 },
  { key: "priceLockMinutes", label: "Price lock (minutes)", min: 5, max: 120 },
  { key: "emiMonths", label: "EMI tenure shown (months)", min: 3, max: 36 },
  { key: "rateGuardPct", label: "Rate move guard (±%)", min: 5, max: 50 },
  { key: "rateMakerChecker", label: "Rate maker-checker (1 = second person approves, 0 = publish instantly)", min: 0, max: 1 },
  { key: "returnWindowDays", label: "Return window (days, 0 = returns off)", min: 0, max: 30 },
  { key: "siteDiscountOn", label: "Site-wide discount on (1/0)", min: 0, max: 1 },
  { key: "siteDiscountPct", label: "Site-wide discount (%)", min: 0, max: 75 },
  { key: "pdpShowGstNote", label: "PDP: show 'Inclusive of GST' (1/0)", min: 0, max: 1 },
  { key: "pdpShowRateNote", label: "PDP: show today's-rate note (1/0)", min: 0, max: 1 },
  { key: "pdpShowLockNote", label: "PDP: show price-lock note (1/0)", min: 0, max: 1 },
  { key: "pdpShowWhatsapp", label: "PDP: show WhatsApp enquiry (1/0)", min: 0, max: 1 },
  { key: "pdpShowCallback", label: "PDP: show call-back request (1/0)", min: 0, max: 1 },
  { key: "pdpShowVisit", label: "PDP: show showroom-visit link (1/0)", min: 0, max: 1 },
  { key: "pdpShowEmi", label: "PDP: show the EMI line (1/0)", min: 0, max: 1 },
  { key: "verificationThreshold", label: "Verification hold from (₹)", min: 50000, max: 1000000 },
  { key: "lowStockThreshold", label: "Low-stock alert at (units)", min: 1, max: 20 },
];

// Registered-entity details printed on tax invoices (BRD 8.4, GST rules).
const SELLER = {
  name: "DP Jewellers Pvt. Ltd.",
  address: "12 Palasia Square, A.B. Road, Indore, Madhya Pradesh 452001",
  gstin: "23AAACD1234E1Z5", // state code 23 — Madhya Pradesh
  pan: "AAACD1234E",
  phone: "+91 731 400 1122",
  email: "care@dpjewellers.example",
  note: "BIS-registered hallmarking jeweller. All prices include GST.",
};

// Engraving-capable pieces (FR-PDP-12). Synced onto the persisted catalogue
// at boot so the flag survives even though products live in db.json.
const ENGRAVABLE_SLUGS = [
  "meera-classic-band",
  "vault-signet-ring",
  "polar-platinum-band",
  "cleo-chain-bracelet",
  "atlas-rope-chain",
];
const ENGRAVING_MAX = 12;
products.forEach((p) => {
  p.engravable = ENGRAVABLE_SLUGS.includes(p.slug);
  // Inventory (FR-INV): finished pieces carry a stock count; made-to-order
  // pieces are crafted on demand (stock = null, never blocks). Seeded once
  // for catalogue entries that predate this field; admin edits thereafter.
  if (!Number.isFinite(p.stock) && p.stock !== null) {
    p.stock = p.madeToOrder ? null : 6;
  }
});
save();

// Order lifecycle (BRD FR-OMS-01).
const ORDER_FLOW = [
  "Placed",
  "Confirmed",
  "Under Quality Check",
  "Packed",
  "Shipped",
  "Out for Delivery",
  "Delivered",
];
const SPECIAL_STATUS = ["Cancelled", "Returned", "Refunded"];

function canTransition(from, to) {
  if (from === "Verification Pending")
    return to === "Confirmed" || to === "Cancelled";
  const fi = ORDER_FLOW.indexOf(from);
  const ti = ORDER_FLOW.indexOf(to);
  if (ti !== -1 && fi !== -1) return ti > fi; // forward moves only
  if (to === "Cancelled")
    // cutoff is admin-configurable: cancellable strictly BEFORE that status
    return fi !== -1 && fi < ORDER_FLOW.indexOf(config.cancelCutoffStatus);
  if (to === "Returned") return from === "Delivered";
  if (to === "Refunded") return from === "Cancelled" || from === "Returned";
  return false;
}

function nextStatuses(from) {
  return ORDER_FLOW.concat(SPECIAL_STATUS).filter((to) => canTransition(from, to));
}

// ------------------------------------------------------------------ helpers
// Discounts never compound: the customer pays the LARGEST single percentage
// among per-product, (future) per-category, and the site-wide sale.
function effectiveDiscountPct(product) {
  return Math.max(
    Number(product.discountPct) || 0,
    config.siteDiscountOn ? config.siteDiscountPct : 0
  );
}

/* Discount rules engine (Admin → Settings → Discounts). Each rule targets
   the whole price or the making charges only, gated by product conditions
   (metal / purity / category / collection / occasion / minimum value),
   an audience (everyone, gold-scheme holders, first-time or returning
   customers — resolved at billing when the phone is known), a validity
   window, and a priority. Per-piece and site-wide markdowns compete in the
   same contest at priority 0, so a piece is still never discounted twice:
   highest priority wins, then the largest rupee saving. */
if (!Array.isArray(db.discountRules)) db.discountRules = [];

function discountRuleActive(rule, now) {
  if (!rule.on) return false;
  if (rule.startsAt && now < Date.parse(`${rule.startsAt}T00:00:00`)) return false;
  if (rule.endsAt && now > Date.parse(`${rule.endsAt}T23:59:59`)) return false;
  return true;
}

// ctx is null for anonymous browsing; { hasScheme, orderCount } at billing
function discountRuleMatches(rule, product, bare, ctx) {
  if (rule.audience === "scheme" && !ctx?.hasScheme) return false;
  if (rule.audience === "first" && !(ctx && ctx.orderCount === 0)) return false;
  if (rule.audience === "returning" && !(ctx && ctx.orderCount > 0)) return false;
  if (rule.metal && product.metal.type !== rule.metal) return false;
  if (rule.purity && product.metal.purity !== rule.purity) return false;
  if (rule.category && product.category !== rule.category) return false;
  if (rule.collection && (product.collection || "").toLowerCase() !== rule.collection.toLowerCase()) return false;
  if (rule.occasion && !(product.occasion || []).includes(rule.occasion)) return false;
  if (rule.minTotal > 0 && bare.subtotal < rule.minTotal) return false;
  return true;
}

function winningDiscount(product, ctx = null) {
  const bare = computePrice(product, db.rates, undefined, 0);
  const candidates = [];
  const basePct = effectiveDiscountPct(product);
  if (basePct > 0)
    candidates.push({
      pct: basePct, base: "price", label: null, priority: 0,
      value: (bare.subtotal * basePct) / 100,
    });
  const now = Date.now();
  for (const rule of db.discountRules) {
    if (!discountRuleActive(rule, now)) continue;
    if (!discountRuleMatches(rule, product, bare, ctx)) continue;
    const value = ((rule.target === "making" ? bare.makingCharges : bare.subtotal) * rule.pct) / 100;
    if (value <= 0) continue;
    candidates.push({ pct: rule.pct, base: rule.target === "making" ? "making" : "price", label: rule.name, priority: rule.priority || 0, value });
  }
  if (candidates.length === 0) return 0;
  candidates.sort((a, b) => b.priority - a.priority || b.value - a.value);
  const win = candidates[0];
  return { pct: win.pct, base: win.base, label: win.label };
}

function priceOf(product, ctx = null) {
  return computePrice(product, db.rates, undefined, winningDiscount(product, ctx));
}

function priced(product) {
  return { ...product, price: priceOf(product) };
}

function listItem(p) {
  const { description, ...rest } = priced(p);
  return rest;
}

// ------------- customisation engine (Bluestone-style PDP variants) --------
// A piece can be re-derived live in another gold karat, another diamond
// quality band, or another size. The price is never adjusted client-side:
// every selection re-runs the same BRD 7.2 formula on a derived product.
const DIAMOND_QUALITIES = [
  { key: "SI-IJ", label: "SI IJ", factor: 0.62 },
  { key: "SI-GH", label: "SI GH", factor: 0.74 },
  { key: "VS-GH", label: "VS GH", factor: 0.88 },
  { key: "VVS-EF", label: "VVS EF", factor: 1 },
];
const SIZE_WEIGHT_STEP_PCT = 2; // each size step up/down moves metal weight this %

// The catalogued clarity/colour anchor the piece to one of the four bands;
// its catalogued ratePerCarat is the price OF that band.
function diamondGradeOf(stone) {
  const clarity = String(stone.clarity || "VS").toUpperCase();
  const colour = String(stone.colour || "G").toUpperCase()[0];
  if (/^(VVS|IF|FL)/.test(clarity)) return "VVS-EF";
  if (clarity.startsWith("VS")) return "VS-GH";
  return "EFGH".includes(colour) ? "SI-GH" : "SI-IJ";
}

// the catalogued weight belongs to the middle listed size
function baseSizeOf(product) {
  const sizes = product.sizes || [];
  return sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : null;
}

function productCustomization(product) {
  const purities =
    product.metal.type === "gold"
      ? Object.keys(db.rates.gold || {})
          .filter((k) => k !== "24K" && typeof db.rates.gold[k] === "number")
          .sort((a, b) => parseInt(b) - parseInt(a))
          .map((key) => ({ key, ratePerGram: db.rates.gold[key] }))
      : [];
  const diamond = (product.stones || []).find((s) => s.type === "diamond");
  const sizes = product.sizes || [];
  if (purities.length < 2 && !diamond && sizes.length < 2) return null;
  return {
    basePurity: product.metal.purity,
    colour: product.metal.colour || null,
    purities,
    diamond: diamond
      ? {
          base: diamondGradeOf(diamond),
          caratTotal: diamond.caratTotal,
          options: DIAMOND_QUALITIES.map(({ key, label }) => ({ key, label })),
        }
      : null,
    baseSize: baseSizeOf(product),
    sizeStepPct: sizes.length > 1 ? SIZE_WEIGHT_STEP_PCT : 0,
  };
}

// item {purity?, quality?, size?} → derived product + a human note like
// "14K · VVS EF". Invalid selections are a 400, never a silent fallback —
// an order must mean exactly what the customer saw.
function applyVariant(product, item = {}) {
  let derived = product;
  const noteParts = [];

  const wantPurity = item.purity ? String(item.purity).toUpperCase() : null;
  if (wantPurity && wantPurity !== product.metal.purity) {
    if (product.metal.type !== "gold" || wantPurity === "24K" || typeof db.rates.gold?.[wantPurity] !== "number")
      throw httpError(400, `${product.name} is not available in ${wantPurity}.`);
    derived = { ...derived, metal: { ...derived.metal, purity: wantPurity } };
    noteParts.push(wantPurity);
  }

  const wantQ = item.quality ? String(item.quality).toUpperCase() : null;
  if (wantQ) {
    const stones = (derived.stones || []).slice();
    const di = stones.findIndex((s) => s.type === "diamond");
    const grade = DIAMOND_QUALITIES.find((g) => g.key === wantQ);
    if (di === -1 || !grade)
      throw httpError(400, `${product.name} has no ${String(item.quality).replace("-", " ")} diamond option.`);
    const base = DIAMOND_QUALITIES.find((g) => g.key === diamondGradeOf(stones[di]));
    if (grade.key !== base.key) {
      const [clar, col] = grade.label.split(" ");
      stones[di] = {
        ...stones[di],
        ratePerCarat: Math.round((stones[di].ratePerCarat * grade.factor) / base.factor),
        clarity: clar,
        colour: col,
      };
      derived = { ...derived, stones };
      noteParts.push(grade.label);
    }
  }

  if (item.size && (product.sizes || []).length > 1) {
    const size = String(item.size);
    if (!product.sizes.includes(size))
      throw httpError(400, `${product.name} is not available in ${(product.sizeLabel || "size").toLowerCase()} ${size}.`);
    const steps = product.sizes.indexOf(size) - product.sizes.indexOf(baseSizeOf(product));
    if (steps !== 0) {
      const f = 1 + (steps * SIZE_WEIGHT_STEP_PCT) / 100;
      derived = {
        ...derived,
        metal: {
          ...derived.metal,
          netWeight: Math.round(derived.metal.netWeight * f * 1000) / 1000,
          grossWeight: Math.round(derived.metal.grossWeight * f * 1000) / 1000,
        },
      };
    }
  }

  return { product: derived, note: noteParts.join(" · ") || null };
}

function newId(prefix) {
  return (
    prefix +
    new Date().toISOString().slice(2, 10).replace(/-/g, "") +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

// ---------------- promotion engine (BRD FR-CMS-05/06, FR-CHK-04) ----------
// Coupon types: percent (with optional cap), flat, makingWaiver (% off the
// cart's making-charge component). Discounts are always recomputed
// server-side; the statutory checks (COD ceiling, PAN) apply to the payable.
if (!Array.isArray(db.coupons)) db.coupons = [];
if (db.coupons.length === 0) {
  db.coupons.push({
    code: "WELCOME10",
    type: "percent",
    value: 10,
    maxDiscount: 5000,
    minTotal: 10000,
    expiresAt: null,
    maxUses: null,
    uses: 0,
    active: true,
    createdAt: new Date().toISOString(),
    description: "10% off your first bag (up to ₹5,000)",
  });
  save();
}

function applyCoupon(code, lines, total) {
  const coupon = db.coupons.find(
    (c) => c.code === String(code).trim().toUpperCase() && c.active
  );
  if (!coupon) throw httpError(400, "That coupon code isn't valid.");
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date())
    throw httpError(400, `Code ${coupon.code} expired on ${new Date(coupon.expiresAt).toLocaleDateString("en-IN")}.`);
  if (coupon.maxUses && coupon.uses >= coupon.maxUses)
    throw httpError(400, `Code ${coupon.code} has been fully redeemed.`);
  if (coupon.minTotal && total < coupon.minTotal)
    throw httpError(400, `Code ${coupon.code} needs a bag of at least ₹${coupon.minTotal.toLocaleString("en-IN")}.`);

  let discount = 0;
  if (coupon.type === "percent") {
    discount = (total * coupon.value) / 100;
    if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  } else if (coupon.type === "flat") {
    discount = Math.min(coupon.value, total);
  } else if (coupon.type === "makingWaiver") {
    const makingSum = lines.reduce((sum, l) => {
      const product = products.find((p) => p.slug === l.slug);
      return sum + computePrice(product, db.rates).makingCharges * l.qty;
    }, 0);
    discount = (makingSum * coupon.value) / 100;
  }
  return { coupon, discount: Math.round(discount) };
}

// Shared validation for checkout — prices always recomputed server-side.
// `req` is needed when the buyer redeems loyalty points (session check).
function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function buildOrderDraft(body, req) {
  const { items, customer, payment, fulfilment, gift, gstin } = body || {};
  if (!Array.isArray(items) || items.length === 0)
    throw httpError(400, "Your bag is empty.");
  if (!customer || !customer.name || !customer.phone)
    throw httpError(400, "Contact details are incomplete.");
  if (!/^[6-9]\d{9}$/.test(String(customer.phone)))
    throw httpError(400, "Enter a valid 10-digit mobile number.");

  // billing-time customer context — lets audience-gated discount rules
  // (gold-scheme holders, first order, returning) apply at checkout
  const billingPhone = String(customer.phone);
  const billingCtx = {
    hasScheme: db.schemes.some((s) => s.customer.phone === billingPhone && s.status === "active"),
    orderCount: db.orders.filter((o) => o.customer.phone === billingPhone && o.status !== "Cancelled").length,
  };

  // Fulfilment: insured shipping (default) or store pickup (FR-CHK-11)
  const method = fulfilment?.method === "pickup" ? "pickup" : "ship";
  let pickupStore = null;
  if (method === "pickup") {
    pickupStore = db.stores.find((s) => s.key === fulfilment?.store);
    if (!pickupStore) throw httpError(400, "Choose a showroom for pickup.");
  } else if (!customer.address) {
    throw httpError(400, "Delivery address is required for shipping.");
  }

  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(String(gstin).toUpperCase()))
    throw httpError(400, "That GSTIN doesn't look valid (15 characters, e.g. 23ABCDE1234F1Z5).");

  // Delivery area (admin Settings): when a firm location is set, shipped
  // orders must come from within the radius. Store pickup is always allowed.
  if (method === "ship" && config.deliveryLat != null && config.deliveryLng != null && config.deliveryRadiusKm > 0) {
    const lat = Number(body.location?.lat);
    const lng = Number(body.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      throw httpError(
        400,
        `We currently deliver within ${config.deliveryRadiusKm} km of our showroom. Allow location access at checkout so we can confirm you're in range — or choose store pickup.`
      );
    const away = haversineKm(config.deliveryLat, config.deliveryLng, lat, lng);
    if (away > config.deliveryRadiusKm)
      throw httpError(
        400,
        `That location is ${away.toFixed(1)} km away — we currently deliver within ${config.deliveryRadiusKm} km. Store pickup is always available.`
      );
  }

  const lines = [];
  for (const item of items) {
    const product = published().find((p) => p.slug === item.slug);
    if (!product) throw httpError(400, `Unknown item: ${item.slug}`);
    const qty = Math.max(1, Math.min(5, Number(item.qty) || 1));

    let engraving = null;
    if (item.engraving) {
      if (!product.engravable)
        throw httpError(400, `${product.name} cannot be engraved.`);
      engraving = String(item.engraving).trim().slice(0, ENGRAVING_MAX);
      if (!/^[A-Za-z0-9 .&'-]+$/.test(engraving))
        throw httpError(400, "Engraving may use letters, numbers, spaces and . & ' - only.");
    }

    // customisation (karat / diamond quality / size) re-derives the piece;
    // the price the customer pays is computed from the derived product
    const { product: variant, note: variantNote } = applyVariant(product, item);
    const price = priceOf(variant, billingCtx);
    lines.push({
      slug: product.slug,
      name: product.name,
      image: product.images[0],
      size: item.size || null,
      custom:
        item.purity || item.quality
          ? { purity: item.purity || null, quality: item.quality || null }
          : null,
      variantNote,
      engraving,
      qty,
      unitPrice: price.total,
      lineTotal: price.total * qty,
      hsn: product.hsn || "7113",
      huid: product.huid || null,
      // per-unit tax break-up frozen at order time for the GST invoice —
      // taxable is the post-markdown consideration GST was charged on
      unitBreak: { taxable: price.taxable, gst: price.gst, gstDetail: price.gstDetail },
    });
  }
  const short = stockShortfall(lines);
  if (short) throw httpError(409, short);
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);

  // Order thresholds (admin Settings): smallest bag a customer may check out.
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  if (itemCount < config.minOrderQty)
    throw httpError(400, `Orders need at least ${config.minOrderQty} item${config.minOrderQty > 1 ? "s" : ""}.`);
  if (total < config.minOrderValue)
    throw httpError(
      400,
      `The minimum order value is ₹${config.minOrderValue.toLocaleString("en-IN")} — this bag is ₹${total.toLocaleString("en-IN")}.`
    );

  const mode = payment?.mode || "upi";

  let discount = 0;
  let couponCode = null;
  if (body.coupon) {
    const applied = applyCoupon(body.coupon, lines, total);
    discount = applied.discount;
    couponCode = applied.coupon.code;
  }

  // Referral code — flat first-order discount for the friend (DPJ Rewards).
  let referral = null;
  if (body.referralCode) {
    const code = String(body.referralCode).trim().toUpperCase();
    const referrer = Object.values(db.loyalty).find((a) => a.referralCode === code);
    if (!referrer) throw httpError(400, "That referral code isn't valid.");
    if (referrer.phone === String(customer.phone))
      throw httpError(400, "Nice try — you can't refer yourself.");
    if (db.orders.some((o) => o.customer.phone === String(customer.phone) && o.status !== "Cancelled"))
      throw httpError(400, "Referral rewards apply to first orders only.");
    if (total - discount < LOYALTY.referralMinTotal)
      throw httpError(400, `The referral offer needs a bag of at least ₹${LOYALTY.referralMinTotal.toLocaleString("en-IN")}.`);
    referral = { code, referrerPhone: referrer.phone, discount: LOYALTY.referralFlatOff };
    discount += LOYALTY.referralFlatOff;
  }

  // Loyalty points — spend like rupees, capped, session-verified.
  let redeemed = null;
  if (body.redeemPoints) {
    const authed = req ? authedCustomer(req) : null;
    if (!authed) throw httpError(401, "Sign in to pay with your points.");
    if (authed.phone !== String(customer.phone))
      throw httpError(400, "Points can only be used with the signed-in mobile number.");
    const acc = loyaltyAccount(authed.phone);
    const want = Math.floor(Number(body.redeemPoints));
    if (!(want > 0)) throw httpError(400, "Enter a whole number of points.");
    if (want > acc.points) throw httpError(400, `You have ${acc.points} points available.`);
    const cap = Math.floor(((total - discount) * LOYALTY.redeemCapPct) / 100 / LOYALTY.redeemValue);
    const points = Math.min(want, cap);
    if (points <= 0) throw httpError(400, `Points can cover at most ${LOYALTY.redeemCapPct}% of the bag.`);
    redeemed = { points, value: points * LOYALTY.redeemValue };
  }

  const payable = total - discount - (redeemed ? redeemed.value : 0);

  if (mode === "cod" && payable > config.codCeiling)
    throw httpError(
      400,
      `Cash on delivery is available only for orders up to ₹${config.codCeiling.toLocaleString("en-IN")}. Please choose an online payment mode.`
    );
  if (payable >= config.panThreshold) {
    const pan = String(customer.pan || "").toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan))
      throw httpError(
        400,
        `PAN is required for orders of ₹${config.panThreshold.toLocaleString("en-IN")} and above (Income Tax Rule 114B).`
      );
  }

  // GPS snapshot when the customer shared their location at checkout —
  // the admin console links straight to the pin for the delivery run.
  const locLat = Number(body.location?.lat);
  const locLng = Number(body.location?.lng);
  const location =
    method === "ship" && Number.isFinite(locLat) && Number.isFinite(locLng)
      ? { lat: locLat, lng: locLng, source: "gps" }
      : null;

  return {
    lines,
    total,
    discount,
    coupon: couponCode,
    referral,
    redeemed,
    payable,
    mode,
    location,
    fulfilment: {
      method,
      store: pickupStore ? { key: pickupStore.key, name: pickupStore.name } : null,
    },
    gift: gift?.wrap
      ? {
          wrap: true,
          message: gift.message ? String(gift.message).slice(0, 200) : null,
          hideInvoiceValue: Boolean(gift.hideInvoiceValue),
        }
      : null,
    gstin: gstin ? String(gstin).toUpperCase() : null,
    customer: {
      name: customer.name,
      phone: String(customer.phone),
      email: customer.email || null,
      address: method === "pickup" ? `Store pickup — ${pickupStore.name}` : customer.address,
      pincode: customer.pincode || null,
    },
  };
}

// Placing an order quietly creates (or enriches) the customer's account —
// the phone number is the identity here, so a later OTP sign-in lands in
// the same account with the order history and delivery address waiting.
function upsertCustomerFromOrder(orderCustomer) {
  const phone = orderCustomer.phone;
  let account = customerByPhone(phone);
  let created = false;
  if (!account) {
    account = {
      phone,
      name: orderCustomer.name || null,
      email: orderCustomer.email || null,
      dob: null,
      anniversary: null,
      ringSize: null,
      addresses: [],
      createdAt: new Date().toISOString(),
    };
    db.customers.push(account);
    created = true;
  } else {
    if (!account.name && orderCustomer.name) account.name = orderCustomer.name;
    if (!account.email && orderCustomer.email) account.email = orderCustomer.email;
  }
  // keep the delivery address on file (pickup pseudo-addresses excluded)
  const line = String(orderCustomer.address || "");
  const pincode = String(orderCustomer.pincode || "");
  if (line && !line.startsWith("Store pickup") && /^[1-9]\d{5}$/.test(pincode)) {
    const dup = account.addresses.some((a) => a.line === line && a.pincode === pincode);
    if (!dup && account.addresses.length < 8) {
      account.addresses.push({
        id: crypto.randomBytes(4).toString("hex"),
        label: account.addresses.length === 0 ? "Home" : "Delivery",
        line,
        pincode,
        city: null,
        isDefault: account.addresses.length === 0,
      });
    }
  }
  return created;
}

function createOrder(draft, paymentStatus, intentId = null) {
  const now = new Date().toISOString();
  let status = paymentStatus === "paid" ? "Confirmed" : "Placed";
  const timeline = [{ status: "Placed", at: now }];
  if (status === "Confirmed")
    timeline.push({ status: "Confirmed", at: now, note: "Payment received" });

  // High-value orders hold for a verification call (FR-OMS-03/04)
  if ((draft.payable ?? draft.total) >= config.verificationThreshold) {
    status = "Verification Pending";
    timeline.push({
      status: "Verification Pending",
      at: now,
      note: "High-value order — our concierge will call to verify before dispatch",
    });
  }

  const order = {
    orderId: newId("DPJ"),
    placedAt: now,
    status,
    statusTimeline: timeline,
    lines: draft.lines,
    total: draft.total,
    discount: draft.discount || 0,
    coupon: draft.coupon || null,
    payable: draft.payable ?? draft.total,
    fulfilment: draft.fulfilment || { method: "ship", store: null },
    gift: draft.gift || null,
    gstin: draft.gstin || null,
    payment: { mode: draft.mode, status: paymentStatus, intentId },
    customer: draft.customer,
    location: draft.location || null,
  };
  if (db.abandoned) delete db.abandoned[draft.customer.phone];
  db.orders.push(order);
  const accountCreated = upsertCustomerFromOrder(order.customer);
  adjustStock(order.lines, -1);
  if (draft.redeemed) {
    const acc = loyaltyAccount(order.customer.phone);
    acc.points -= draft.redeemed.points;
    acc.ledger.push({ at: now, type: "redeemed", points: -draft.redeemed.points, orderId: order.orderId });
    order.loyalty = draft.redeemed;
  }
  if (draft.referral) {
    order.referral = { code: draft.referral.code, discount: draft.referral.discount };
    db.referrals.push({
      code: draft.referral.code,
      referrerPhone: draft.referral.referrerPhone,
      friendPhone: order.customer.phone,
      orderId: order.orderId,
      discount: draft.referral.discount,
      status: "Pending",
      at: now,
    });
  }
  if (draft.coupon) {
    const coupon = db.coupons.find((c) => c.code === draft.coupon);
    if (coupon) coupon.uses += 1;
  }
  notify(
    order.customer.phone,
    "order-placed",
    status === "Verification Pending"
      ? `Order ${order.orderId} of ₹${order.payable.toLocaleString("en-IN")} received. As a high-value purchase, our concierge will call shortly to verify before dispatch.`
      : `Thank you! Order ${order.orderId} of ₹${order.payable.toLocaleString("en-IN")} is ${status.toLowerCase()}. Track it anytime at dpjewellers.example/track.`,
    ["sms", "whatsapp", "email"]
  );
  if (accountCreated)
    notify(
      order.customer.phone,
      "account",
      `Your DP Jewellers account is ready — sign in with this mobile number on the Account page to see your orders, returns and rewards, no password needed.`,
      ["sms"]
    );
  if (invoiceEligible(order)) ensureInvoice(order);
  save();
  return order;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------- notifications (BRD FR-NOT) ------------------------------
// Every customer-facing event is recorded with the exact message a live
// SMS/WhatsApp/email gateway would deliver — only the transport is
// simulated. A provider integration replaces this one function.
if (!Array.isArray(db.notifications)) db.notifications = [];

function notify(phone, event, message, channels = ["sms", "whatsapp"]) {
  const record = {
    id: newId("NTF"),
    at: new Date().toISOString(),
    phone: phone || null,
    event,
    channels,
    message,
    status: providers.sms.mode === "simulated" ? "simulated" : "sending",
  };
  db.notifications.push(record);
  if (db.notifications.length > 800)
    db.notifications.splice(0, db.notifications.length - 800);
  // Live SMS provider (env-configured): fire-and-forget, then record fate.
  if (phone && channels.includes("sms") && providers.sms.mode !== "simulated") {
    providers.sms.send(phone, message).then((r) => {
      record.status = r.delivered ? `sent (${providers.sms.mode})` : `failed (${r.detail})`;
      save();
    });
  }
  // callers persist via their own save()
}

// ---------------- inventory helpers (FR-INV) ------------------------------
// stock === null means made-to-order (never blocks). Checked at draft time
// and re-checked at payment confirm, since stock can move in between.
function stockShortfall(lines) {
  const wanted = {};
  for (const l of lines) wanted[l.slug] = (wanted[l.slug] || 0) + l.qty;
  for (const [slug, qty] of Object.entries(wanted)) {
    const product = products.find((p) => p.slug === slug);
    if (!product || !Number.isFinite(product.stock)) continue;
    if (product.stock < qty) {
      return product.stock === 0
        ? `${product.name} has just sold out. Remove it from your bag to continue.`
        : `Only ${product.stock} of ${product.name} ${product.stock === 1 ? "is" : "are"} left — please reduce the quantity.`;
    }
  }
  return null;
}

function adjustStock(lines, direction) {
  for (const l of lines) {
    const product = products.find((p) => p.slug === l.slug);
    if (product && Number.isFinite(product.stock))
      product.stock = Math.max(0, product.stock + direction * l.qty);
  }
}

// ---------------- GST tax invoice (BRD 8.4, FR-OMS) -----------------------
// Sequential number series per fiscal year, assigned once when the invoice
// is first eligible (payment received, or a COD order confirmed).
if (!Number.isFinite(db.invoiceSeq)) db.invoiceSeq = 0;

function fiscalYearLabel(d) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

function invoiceEligible(order) {
  if (order.payment.status === "paid") return true;
  return ORDER_FLOW.indexOf(order.status) >= ORDER_FLOW.indexOf("Confirmed");
}

function ensureInvoice(order) {
  if (order.invoice) return order.invoice;
  if (!invoiceEligible(order)) return null;
  db.invoiceSeq += 1;
  order.invoice = {
    number: `INV/${fiscalYearLabel(new Date())}/${String(db.invoiceSeq).padStart(4, "0")}`,
    issuedAt: new Date().toISOString(),
  };
  save();
  return order.invoice;
}

// Amount in words, Indian numbering (GST invoices carry this line).
function amountInWords(n) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`);
  const three = (x) => (x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x));
  let v = Math.round(Math.abs(n));
  if (v === 0) return "Zero Rupees Only";
  const parts = [];
  const crore = Math.floor(v / 10000000); v %= 10000000;
  const lakh = Math.floor(v / 100000); v %= 100000;
  const thousand = Math.floor(v / 1000); v %= 1000;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (v) parts.push(three(v));
  return `${parts.join(" ")} Rupees Only`;
}

// ------------------------------------------------------------------ public
app.get("/api/health", (req, res) =>
  res.json({ ok: true, storage: storage.backend, detail: storage.detail, providers: providers.status() })
);
app.get("/api/config", (req, res) => res.json({ ...config, emiPlans: db.emiPlans }));

// ------------------------------------------------- EMI bank-partner plans
// Admin-managed financing schemes shown on the product page. With no plans
// the PDP falls back to the simple interest-free line using emiMonths, so a
// fresh store never advertises invented bank offers.
if (!Array.isArray(db.emiPlans)) db.emiPlans = [];

app.patch("/api/admin/emi-plans", requireAdmin, (req, res) => {
  const raw = req.body?.plans;
  if (!Array.isArray(raw))
    return res.status(400).json({ error: "Send plans as a list." });
  if (raw.length > 10)
    return res.status(400).json({ error: "Keep it to 10 EMI plans or fewer." });
  const clean = [];
  for (const entry of raw) {
    const bank = String(entry?.bank || "").trim().slice(0, 40);
    const months = Math.round(Number(entry?.months));
    const ratePct = Number(entry?.ratePct ?? 0);
    const minAmount = Math.round(Number(entry?.minAmount ?? 0));
    if (!bank)
      return res.status(400).json({ error: "Every plan needs the bank or partner name." });
    if (!Number.isFinite(months) || months < 3 || months > 36)
      return res.status(400).json({ error: `Tenure for ${bank} must be between 3 and 36 months.` });
    if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 30)
      return res.status(400).json({ error: `Interest for ${bank} must be between 0 and 30% a year.` });
    if (!Number.isFinite(minAmount) || minAmount < 0)
      return res.status(400).json({ error: `Minimum amount for ${bank} can't be negative.` });
    clean.push({ bank, months, ratePct: Math.round(ratePct * 100) / 100, minAmount });
  }
  db.emiPlans = clean;
  audit(
    "emi",
    clean.length
      ? `${clean.length} plan${clean.length === 1 ? "" : "s"}: ${[...new Set(clean.map((p) => p.bank))].join(", ")}`
      : "cleared - back to the simple EMI line"
  );
  save();
  res.json({ ok: true, plans: db.emiPlans });
});

// -------------------------------------------------- discount rules (admin)
const RULE_TARGETS = ["price", "making"];
const RULE_AUDIENCES = ["all", "scheme", "first", "returning"];
const RULE_METALS = ["", "gold", "silver", "platinum"];

app.get("/api/admin/discount-rules", requireAdmin, (req, res) =>
  res.json({ rules: db.discountRules })
);

app.patch("/api/admin/discount-rules", requireAdmin, (req, res) => {
  const raw = req.body?.rules;
  if (!Array.isArray(raw))
    return res.status(400).json({ error: "Send rules as a list." });
  if (raw.length > 20)
    return res.status(400).json({ error: "Keep it to 20 discount rules or fewer." });
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const clean = [];
  for (const entry of raw) {
    const name = String(entry?.name || "").trim().slice(0, 40);
    const pct = Number(entry?.pct);
    const target = RULE_TARGETS.includes(entry?.target) ? entry.target : "price";
    const audience = RULE_AUDIENCES.includes(entry?.audience) ? entry.audience : "all";
    const metal = String(entry?.metal || "").trim().toLowerCase();
    const purity = String(entry?.purity || "").trim().toUpperCase().slice(0, 10);
    const category = String(entry?.category || "").trim().toLowerCase().slice(0, 30);
    const collection = String(entry?.collection || "").trim().slice(0, 40);
    const occasion = String(entry?.occasion || "").trim().toLowerCase().slice(0, 30);
    const minTotal = Math.max(0, Math.round(Number(entry?.minTotal) || 0));
    const priority = Math.round(Number(entry?.priority) || 0);
    const startsAt = String(entry?.startsAt || "").trim();
    const endsAt = String(entry?.endsAt || "").trim();
    if (!name)
      return res.status(400).json({ error: "Every rule needs a name — it shows on the price break-up." });
    if (!Number.isFinite(pct) || pct < 1 || pct > 75)
      return res.status(400).json({ error: `Percent for "${name}" must be between 1 and 75.` });
    if (!RULE_METALS.includes(metal))
      return res.status(400).json({ error: `Metal for "${name}" must be gold, silver or platinum (or blank for any).` });
    if (priority < 0 || priority > 100)
      return res.status(400).json({ error: `Priority for "${name}" must be 0–100.` });
    if ((startsAt && !DATE_RE.test(startsAt)) || (endsAt && !DATE_RE.test(endsAt)))
      return res.status(400).json({ error: `Dates for "${name}" must be YYYY-MM-DD.` });
    if (startsAt && endsAt && endsAt < startsAt)
      return res.status(400).json({ error: `"${name}" ends before it starts.` });
    clean.push({
      name, on: entry?.on === false ? false : true,
      pct: Math.round(pct * 10) / 10, target, audience,
      metal, purity, category, collection, occasion,
      minTotal, priority, startsAt, endsAt,
    });
  }
  db.discountRules = clean;
  audit(
    "discounts",
    clean.length
      ? `${clean.length} rule${clean.length === 1 ? "" : "s"}: ${clean.map((r) => `${r.name} ${r.pct}% ${r.target}${r.on ? "" : " (off)"}`).join("; ")}`
      : "all discount rules removed"
  );
  save();
  res.json({ ok: true, rules: db.discountRules });
});

app.get("/api/rates", (req, res) =>
  res.json({ rates: db.rates, updatedAt: db.ratesUpdatedAt })
);

// Per-category promotional banner overrides (Admin → Settings → Category
// banners). Stored on their own key so the picture and the product listings
// are fully independent — swapping one never touches the other; a blank
// override falls back to the built-in house image.
if (!db.categoryMedia || typeof db.categoryMedia !== "object" || Array.isArray(db.categoryMedia))
  db.categoryMedia = {};
const catImage = (c) => db.categoryMedia[c.key] || c.image;

app.get("/api/categories", (req, res) => {
  res.json(
    categories.map((c) => ({
      ...c,
      image: catImage(c),
      custom: Boolean(db.categoryMedia[c.key]),
      count: published().filter((p) => p.category === c.key).length,
    }))
  );
});

app.patch("/api/admin/categories", requireAdmin, (req, res) => {
  const { key, image } = req.body || {};
  const cat = categories.find((c) => c.key === key);
  if (!cat) return res.status(400).json({ error: "Unknown category." });
  const url = String(image || "").trim();
  if (url && !/^(\/|https?:\/\/)/.test(url))
    return res.status(400).json({ error: "The banner must be an upload or an http(s) URL." });
  if (url) db.categoryMedia[cat.key] = url;
  else delete db.categoryMedia[cat.key];
  audit("categories", `${cat.label} banner ${url ? "updated" : "restored to the house default"}`);
  save();
  res.json({
    ok: true,
    categories: categories.map((c) => ({
      ...c,
      image: catImage(c),
      custom: Boolean(db.categoryMedia[c.key]),
    })),
  });
});

// Mega-menu data (storefront header): live design counts, occasion splits
// and true "starting at" prices per metal/purity — computed from the
// published catalogue at today's rates with current discounts applied.
app.get("/api/menu", (req, res) => {
  const menu = categories
    .map((c) => {
      const items = published().filter((p) => p.category === c.key);
      if (items.length === 0) return null;
      const pricedItems = items.map((p) => ({ p, total: priceOf(p).total }));
      const occCount = {};
      for (const { p } of pricedItems)
        for (const o of p.occasion || []) occCount[o] = (occCount[o] || 0) + 1;
      const metals = {};
      const purities = {};
      for (const { p, total } of pricedItems) {
        const m = p.metal.type;
        if (!(m in metals) || total < metals[m]) metals[m] = total;
        const pu = p.metal.purity;
        if (!(pu in purities) || total < purities[pu]) purities[pu] = total;
      }
      return {
        key: c.key,
        label: c.label,
        image: catImage(c),
        tagline: c.tagline,
        count: items.length,
        occasions: Object.entries(occCount)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => ({ key, count })),
        metals: Object.entries(metals).map(([type, from]) => ({ type, from })),
        purities: Object.entries(purities).map(([purity, from]) => ({ purity, from })),
      };
    })
    .filter(Boolean);
  res.json({ menu });
});

app.get("/api/products", (req, res) => {
  const { category, metal, purity, occasion, gender, minPrice, maxPrice, q, sort, featured, limit } = req.query;
  let items = published().map(listItem);

  if (category) {
    const cats = String(category).split(",");
    items = items.filter((p) => cats.includes(p.category));
  }
  if (metal) {
    const metals = String(metal).split(",");
    items = items.filter((p) => metals.includes(p.metal.type));
  }
  if (purity) {
    const purities = String(purity).split(",");
    items = items.filter((p) => purities.includes(p.metal.purity));
  }
  if (occasion) {
    const occ = String(occasion).split(",");
    items = items.filter((p) => p.occasion.some((o) => occ.includes(o)));
  }
  if (gender) items = items.filter((p) => p.gender === gender || p.gender === "unisex");
  if (minPrice) items = items.filter((p) => p.price.total >= Number(minPrice));
  if (maxPrice) items = items.filter((p) => p.price.total <= Number(maxPrice));
  if (featured === "true") items = items.filter((p) => p.featured);

  if (q) {
    const needle = String(q).toLowerCase().replace(/\s+/g, "");
    items = items.filter((p) =>
      [p.name, p.category, p.collection, p.metal.type, p.metal.purity]
        .concat(p.occasion)
        .concat(p.stones.map((s) => s.type))
        .join(" ")
        .toLowerCase()
        .replace(/\s+/g, "")
        .includes(needle)
    );
  }

  switch (sort) {
    case "price-asc": items.sort((a, b) => a.price.total - b.price.total); break;
    case "price-desc": items.sort((a, b) => b.price.total - a.price.total); break;
    case "newest": items.sort((a, b) => b.id.localeCompare(a.id)); break;
    case "popularity": items.sort((a, b) => b.reviews - a.reviews); break;
    case "weight": items.sort((a, b) => a.metal.netWeight - b.metal.netWeight); break;
    default: break;
  }

  const total = items.length;

  // Search-term analytics (BRD FR-SRC-09)
  if (q && String(q).trim().length >= 2) {
    if (!Array.isArray(db.searchLog)) db.searchLog = [];
    db.searchLog.push({ term: String(q).trim().toLowerCase(), results: total, at: new Date().toISOString() });
    if (db.searchLog.length > 500) db.searchLog.splice(0, db.searchLog.length - 500);
    save();
  }

  if (limit) items = items.slice(0, Number(limit));
  res.json({ total, items, ratesUpdatedAt: db.ratesUpdatedAt });
});

app.get("/api/products/:slug", (req, res) => {
  const product = published().find((p) => p.slug === req.params.slug);
  if (!product) return res.status(404).json({ error: "Product not found" });
  const related = published()
    .filter((p) => p.slug !== product.slug && (p.category === product.category || p.collection === product.collection))
    .slice(0, 4)
    .map(listItem);
  res.json({
    product: priced(product),
    related,
    customization: productCustomization(product),
    ratesUpdatedAt: db.ratesUpdatedAt,
  });
});

// Live variant quote — the PDP re-derives the price server-side as the
// customer flips karat / diamond quality / size. Same formula, same
// discount contest; the client only ever displays what this returns.
app.get("/api/products/:slug/quote", (req, res) => {
  const product = published().find((p) => p.slug === req.params.slug);
  if (!product) return res.status(404).json({ error: "Product not found" });
  try {
    const { product: derived, note } = applyVariant(product, {
      purity: req.query.purity || null,
      quality: req.query.quality || null,
      size: req.query.size || null,
    });
    res.json({
      slug: product.slug,
      note,
      selection: {
        purity: derived.metal.purity,
        quality: req.query.quality ? String(req.query.quality).toUpperCase() : null,
        size: req.query.size || null,
      },
      netWeight: derived.metal.netWeight,
      price: priceOf(derived),
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get("/api/pincode/:pin", (req, res) => {
  const pin = req.params.pin;
  if (!/^[1-9]\d{5}$/.test(pin)) return res.json({ valid: false, serviceable: false });
  const first = pin[0];
  const metro = ["1", "4", "5", "6"].includes(first);
  const serviceable = first !== "9";
  res.json({
    valid: true,
    serviceable,
    codAvailable: serviceable && first !== "7",
    etaDays: serviceable ? (metro ? 3 : 6) : null,
    insured: true,
  });
});

// ---------------- payments (simulated gateway; Razorpay drops in here) ----
// 1. POST /api/payments/intent   → validates the order, returns an intent
// 2. POST /api/payments/:id/confirm {outcome} → success creates the order,
//    failure preserves the cart for retry (BRD FR-PAY-05)
app.post("/api/payments/intent", async (req, res) => {
  try {
    const draft = buildOrderDraft(req.body, req);
    if (draft.mode === "cod")
      return res.status(400).json({ error: "COD orders do not need a payment intent." });
    const intent = {
      id: newId("PAY"),
      createdAt: new Date().toISOString(),
      // Quoted price is locked for the checkout window (FR-PRC / FR-CHK);
      // after this, rates may have moved and the intent cannot be captured.
      lockedUntil: new Date(Date.now() + config.priceLockMinutes * 60000).toISOString(),
      status: "pending",
      gateway: providers.payments.mode,
      draft,
    };
    // Live mode: register the order with Razorpay so Checkout can open it.
    if (providers.payments.mode === "razorpay") {
      const gwOrder = await providers.payments.createGatewayOrder(draft.payable, intent.id);
      intent.gatewayOrderId = gwOrder.id;
    }
    db.paymentIntents.push(intent);
    save();
    res.status(201).json({
      intentId: intent.id,
      amount: draft.payable,
      discount: draft.discount,
      mode: draft.mode,
      lockedUntil: intent.lockedUntil,
      priceLockMinutes: config.priceLockMinutes,
      gateway:
        providers.payments.mode === "razorpay" ? "razorpay" : "DPJ Secure Checkout (simulated)",
      gatewayOrderId: intent.gatewayOrderId || null,
      keyId: providers.payments.keyId,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/payments/:id/confirm", (req, res) => {
  const intent = db.paymentIntents.find((i) => i.id === req.params.id);
  if (!intent) return res.status(404).json({ error: "Payment intent not found" });
  if (intent.status !== "pending")
    return res.status(400).json({ error: `Payment already ${intent.status}` });

  if (intent.lockedUntil && new Date(intent.lockedUntil) < new Date()) {
    intent.status = "expired";
    save();
    return res.status(410).json({
      error: `Your ${config.priceLockMinutes}-minute price lock has expired. Metal rates refresh live — please review your bag and check out again.`,
    });
  }

  // Live mode expects Razorpay Checkout's payment id + signature; the
  // simulated modal keeps sending {outcome}.
  let outcome;
  if (intent.gateway === "razorpay") {
    const ok = providers.payments.verifyCheckoutSignature({
      gatewayOrderId: intent.gatewayOrderId,
      paymentId: req.body?.razorpayPaymentId,
      signature: req.body?.razorpaySignature,
    });
    outcome = ok ? "success" : "failed";
    if (ok) intent.gatewayPaymentId = req.body.razorpayPaymentId;
  } else {
    outcome = req.body?.outcome === "success" ? "success" : "failed";
  }
  if (outcome === "failed") {
    intent.status = "failed";
    save();
    return res.status(402).json({
      error:
        intent.gateway === "razorpay"
          ? "Payment could not be verified with the gateway. Your bag is untouched — please retry."
          : "Payment failed at the gateway. Your bag is untouched — please retry or choose another mode.",
    });
  }

  // Stock can move between intent and capture — re-check before charging.
  const short = stockShortfall(intent.draft.lines);
  if (short) {
    intent.status = "cancelled";
    save();
    return res.status(409).json({ error: short });
  }

  intent.status = "captured";
  const order = createOrder(intent.draft, "paid", intent.id);
  res.status(201).json({
    orderId: order.orderId,
    total: order.payable,
    discount: order.discount,
    status: order.status,
    etaDays: 5,
    message: "Payment received. Confirmation is on its way by SMS, email and WhatsApp.",
  });
});

// Razorpay server-to-server webhook — the safety net when the customer's
// browser dies between paying and confirming. Signature-verified against
// the raw body; captures the intent and creates the order idempotently.
app.post("/api/payments/webhook", (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  if (!providers.payments.verifyWebhookSignature(req.body, signature))
    return res.status(400).json({ error: "Bad signature" });
  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Bad payload" });
  }
  if (event.event === "payment.captured") {
    const gwOrderId = event.payload?.payment?.entity?.order_id;
    const intent = db.paymentIntents.find((i) => i.gatewayOrderId === gwOrderId);
    if (intent && intent.status === "pending") {
      intent.status = "captured";
      intent.gatewayPaymentId = event.payload.payment.entity.id;
      const short = stockShortfall(intent.draft.lines);
      if (!short) createOrder(intent.draft, "paid", intent.id);
      save();
    }
  }
  res.json({ ok: true });
});

// COD (and any offline mode) places the order directly.
app.post("/api/orders", (req, res) => {
  try {
    const draft = buildOrderDraft(req.body, req);
    const order = createOrder(draft, draft.mode === "cod" ? "cod-pending" : "unpaid");
    res.status(201).json({
      orderId: order.orderId,
      total: order.payable,
      discount: order.discount,
      status: order.status,
      etaDays: 5,
      message: "Order placed. You will receive confirmation on SMS, email and WhatsApp.",
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Phone-first tracking: every order under a mobile number, product-wise —
// no order id to remember. Same lookup key the schemes/appointments
// "my" endpoints already use.
app.get("/api/track/my", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter the 10-digit mobile used at checkout." });
  const orders = db.orders
    .filter((o) => o.customer.phone === phone)
    .map((o) => ({
      orderId: o.orderId,
      placedAt: o.placedAt,
      status: o.status,
      total: o.payable ?? o.total,
      lines: o.lines.map(({ name, qty, size, image, slug, lineTotal }) => ({ name, qty, size, image, slug, lineTotal })),
      cancellable: canTransition(o.status, "Cancelled"),
      invoiceAvailable: invoiceEligible(o),
    }))
    .reverse();
  res.json({ orders });
});

// Customer order tracking — order id + phone (no login required).
app.get("/api/track", (req, res) => {
  const { orderId, phone } = req.query;
  const order = db.orders.find(
    (o) =>
      o.orderId.toUpperCase() === String(orderId || "").trim().toUpperCase() &&
      o.customer.phone === String(phone || "").trim()
  );
  if (!order)
    return res.status(404).json({ error: "No order found for that ID and mobile number." });
  res.json({
    orderId: order.orderId,
    placedAt: order.placedAt,
    status: order.status,
    statusTimeline: order.statusTimeline,
    total: order.payable ?? order.total,
    discount: order.discount || 0,
    coupon: order.coupon || null,
    payment: { mode: order.payment.mode, status: order.payment.status },
    lines: order.lines.map(({ name, qty, size, image, slug, unitPrice, lineTotal }) => ({ name, qty, size, image, slug, unitPrice, lineTotal })),
    returns: db.returns
      .filter((r) => r.orderId === order.orderId)
      .map(({ id, slug, size, itemName, type, status, refundAmount }) => ({ id, slug, size, itemName, type, status, refundAmount })),
    returnWindowDays: config.returnWindowDays,
    cancellable: canTransition(order.status, "Cancelled"),
    invoiceAvailable: invoiceEligible(order),
  });
});

// ---------------- call-back requests (PDP "Request a call back") ----------
// The concierge promise is real: every request is stored and surfaced in the
// admin until someone marks it as called.
if (!Array.isArray(db.callbacks)) db.callbacks = [];

app.post("/api/callbacks", (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter the 10-digit mobile number we should call." });
  const product = published().find((p) => p.slug === req.body?.slug);
  if (!product) return res.status(400).json({ error: "Unknown product." });
  if (db.callbacks.some((c) => c.phone === phone && c.slug === product.slug && c.status === "New"))
    return res.status(409).json({
      error: "We already have your request for this piece — our concierge will call you shortly.",
    });
  const request = {
    id: newId("CB"),
    at: new Date().toISOString(),
    phone,
    name: name || null,
    slug: product.slug,
    productName: product.name,
    status: "New",
  };
  db.callbacks.push(request);
  notify(
    phone,
    "callback",
    `Thank you! Our concierge will call you about the ${product.name} within 2 hours (10 AM – 8 PM).`
  );
  save();
  res.status(201).json({ ok: true, id: request.id });
});

app.get("/api/admin/callbacks", requireAdmin, (req, res) => {
  res.json([...db.callbacks].reverse());
});

app.patch("/api/admin/callbacks/:id", requireAdmin, (req, res) => {
  const request = db.callbacks.find((c) => c.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "New")
    return res.status(400).json({ error: `Already marked as ${request.status.toLowerCase()}.` });
  request.status = "Called";
  request.calledAt = new Date().toISOString();
  request.calledBy = String(req.body?.by || "admin").slice(0, 40);
  audit("callback", `${request.id}: ${request.phone} called about ${request.productName}`);
  save();
  res.json({ ok: true, request });
});

// ---------------- regional footfall (back office) -------------------------
// Indian PIN codes group into postal circles: the first two digits identify
// the region. Orders are mapped by their delivery PIN; showroom appointment
// bookings give the literal walk-in footfall.
const PIN_CIRCLES = [
  [["11"], "Delhi NCR"],
  [["12", "13"], "Haryana"],
  [["14", "15", "16"], "Punjab & Chandigarh"],
  [["17"], "Himachal Pradesh"],
  [["18", "19"], "Jammu & Kashmir"],
  [["20", "21", "22", "23", "24", "25", "26", "27", "28"], "Uttar Pradesh & Uttarakhand"],
  [["30", "31", "32", "33", "34"], "Rajasthan"],
  [["36", "37", "38", "39"], "Gujarat"],
  [["40", "41", "42", "43", "44"], "Maharashtra & Goa"],
  [["45", "46", "47", "48"], "Madhya Pradesh"],
  [["49"], "Chhattisgarh"],
  [["50"], "Telangana"],
  [["51", "52", "53"], "Andhra Pradesh"],
  [["56", "57", "58", "59"], "Karnataka"],
  [["60", "61", "62", "63", "64"], "Tamil Nadu & Puducherry"],
  [["67", "68", "69"], "Kerala"],
  [["70", "71", "72", "73", "74"], "West Bengal & Sikkim"],
  [["75", "76", "77"], "Odisha"],
  [["78"], "Assam"],
  [["79"], "North-East"],
  [["80", "81", "82", "83", "84", "85"], "Bihar & Jharkhand"],
];
const PIN_REGION = new Map();
for (const [prefixes, name] of PIN_CIRCLES)
  for (const p of prefixes) PIN_REGION.set(p, name);

function pinRegion(pin) {
  const s = String(pin || "");
  return /^[1-9]\d{5}$/.test(s)
    ? PIN_REGION.get(s.slice(0, 2)) || "Other regions"
    : "PIN not recorded";
}

app.get("/api/admin/footfall", requireAdmin, (req, res) => {
  const regions = new Map();
  for (const o of db.orders) {
    const name = pinRegion(o.customer.pincode);
    if (!regions.has(name))
      regions.set(name, { region: name, phones: new Set(), orders: 0, revenue: 0 });
    const r = regions.get(name);
    r.phones.add(o.customer.phone);
    r.orders += 1;
    if (!["Cancelled", "Refunded"].includes(o.status)) r.revenue += o.payable ?? o.total;
  }
  const showrooms = new Map();
  for (const a of db.appointments || []) {
    showrooms.set(a.storeName, (showrooms.get(a.storeName) || 0) + 1);
  }
  res.json({
    regions: [...regions.values()]
      .map(({ region, phones, orders, revenue }) => ({ region, customers: phones.size, orders, revenue }))
      .sort((a, b) => b.customers - a.customers || b.orders - a.orders),
    showrooms: [...showrooms.entries()]
      .map(([storeName, visits]) => ({ storeName, visits }))
      .sort((a, b) => b.visits - a.visits),
  });
});

// ---------------- customer profiles (back office) -------------------------
// One row per phone number: registered accounts AND guest buyers. Reads only —
// never creates loyalty accounts as a side effect.
// One rollup serves the directory and the CSV export.
function customerDirectory() {
  const rows = new Map();
  for (const c of db.customers)
    rows.set(c.phone, {
      phone: c.phone, name: c.name, email: c.email, registered: true,
      since: c.createdAt, orders: 0, spend: 0, lastOrderAt: null,
    });
  for (const o of db.orders) {
    const phone = o.customer.phone;
    if (!rows.has(phone))
      rows.set(phone, {
        phone, name: o.customer.name, email: null, registered: false,
        since: null, orders: 0, spend: 0, lastOrderAt: null,
      });
    const r = rows.get(phone);
    if (!r.name) r.name = o.customer.name;
    r.orders += 1;
    if (!["Cancelled", "Refunded"].includes(o.status)) r.spend += o.payable ?? o.total;
    if (!r.lastOrderAt || o.placedAt > r.lastOrderAt) r.lastOrderAt = o.placedAt;
  }
  return [...rows.values()]
    .map((r) => {
      const acc = db.loyalty[r.phone];
      return { ...r, points: acc?.points ?? 0, tier: acc ? tierOf(acc).name : "Silver" };
    })
    .sort((a, b) => String(b.lastOrderAt || b.since || "").localeCompare(String(a.lastOrderAt || a.since || "")));
}

app.get("/api/admin/customers", requireAdmin, (req, res) => {
  res.json(customerDirectory());
});

app.get("/api/admin/customers/:phone", requireAdmin, (req, res) => {
  const phone = String(req.params.phone).trim();
  const account = db.customers.find((c) => c.phone === phone) || null;
  const orders = db.orders.filter((o) => o.customer.phone === phone);
  const schemes = db.schemes.filter((s) => s.customer?.phone === phone);
  const enquiries = (db.enquiries || []).filter((e) => e.phone === phone);
  const appointments = (db.appointments || []).filter((a) => a.phone === phone);
  if (!account && orders.length === 0 && schemes.length === 0 && enquiries.length === 0 && appointments.length === 0)
    return res.status(404).json({ error: "No customer with that mobile number." });

  const valid = orders.filter((o) => !["Cancelled", "Refunded"].includes(o.status));
  const acc = db.loyalty[phone] || null;
  res.json({
    phone,
    name: account?.name || orders.at(-1)?.customer.name || appointments.at(-1)?.name || enquiries.at(-1)?.name || null,
    account: account
      ? {
          email: account.email, dob: account.dob, anniversary: account.anniversary,
          ringSize: account.ringSize, createdAt: account.createdAt, addresses: account.addresses,
        }
      : null,
    stats: {
      orders: orders.length,
      spend: valid.reduce((s, o) => s + (o.payable ?? o.total), 0),
      lastOrderAt: orders.at(-1)?.placedAt || null,
    },
    orders: [...orders].reverse().map((o) => ({
      orderId: o.orderId, placedAt: o.placedAt, status: o.status,
      payable: o.payable ?? o.total, payMode: o.payment.mode,
      items: o.lines.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ""}`).join(", "),
    })),
    returns: [...db.returns.filter((r) => r.phone === phone)].reverse()
      .map(({ id, orderId, itemName, type, status, refundAmount }) => ({ id, orderId, itemName, type, status, refundAmount })),
    schemes: schemes.map((s) => ({
      id: s.id, variant: s.variant, monthly: s.monthlyAmount, status: s.status,
      instalmentsPaid: s.instalments.length, startedAt: s.startedAt,
    })),
    loyalty: acc
      ? { points: acc.points, lifetimeSpend: acc.lifetimeSpend, tier: tierOf(acc).name,
          referralCode: acc.referralCode, ledger: [...acc.ledger].slice(-8).reverse() }
      : null,
    callbacks: [...db.callbacks.filter((c) => c.phone === phone)].reverse()
      .map(({ id, at, productName, status }) => ({ id, at, productName, status })),
    appointments: [...appointments].reverse()
      .map(({ id, date, slot, storeName, productName, status }) => ({ id, date, slot, storeName, productName, status })),
    enquiries: [...enquiries].reverse().map(({ id, status, budgetBand, description }) => ({
      id, status, budgetBand, description: String(description || "").slice(0, 80),
    })),
  });
});

// ---------------- GST tax invoice (BRD 8.4) -------------------------------
// Fetched by the customer (orderId + phone) or by the back office (admin
// key in header or ?key=, since browser links can't set headers).
app.get("/api/orders/:orderId/invoice", (req, res) => {
  const isAdmin =
    req.headers["x-admin-key"] === ADMIN_KEY || req.query.key === ADMIN_KEY;
  const order = db.orders.find(
    (o) => o.orderId.toUpperCase() === String(req.params.orderId).trim().toUpperCase()
  );
  if (!order || (!isAdmin && order.customer.phone !== String(req.query.phone || "").trim()))
    return res.status(404).json({ error: "No order found for that ID and mobile number." });

  const invoice = ensureInvoice(order);
  if (!invoice)
    return res.status(409).json({
      error: "The tax invoice is issued once payment is received (or a COD order is confirmed).",
    });

  // Intra-state supply (seller registered in MP) → GST splits CGST + SGST.
  const lines = order.lines.map((l) => {
    const estimated = !l.unitBreak; // orders that predate stored break-ups
    const taxable = estimated ? Math.round(l.lineTotal / 1.03) : l.unitBreak.taxable * l.qty;
    const gst = estimated ? l.lineTotal - taxable : l.unitBreak.gst * l.qty;
    return {
      name: l.name,
      slug: l.slug,
      size: l.size,
      variantNote: l.variantNote || null,
      engraving: l.engraving || null,
      qty: l.qty,
      hsn: l.hsn || "7113",
      huid: l.huid || null,
      taxable,
      cgst: Math.round(gst / 2),
      sgst: gst - Math.round(gst / 2),
      gst,
      gross: l.lineTotal,
      estimated,
    };
  });
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  const payable = order.payable ?? order.total;

  res.json({
    invoice,
    seller: SELLER,
    buyer: {
      name: order.customer.name,
      phone: order.customer.phone,
      address: order.customer.address,
      gstin: order.gstin || null,
    },
    order: {
      orderId: order.orderId,
      placedAt: order.placedAt,
      status: order.status,
      payment: { mode: order.payment.mode, status: order.payment.status },
      fulfilment: order.fulfilment || { method: "ship" },
    },
    lines,
    totals: {
      taxable: sum("taxable"),
      cgst: sum("cgst"),
      sgst: sum("sgst"),
      gst: sum("gst"),
      gross: sum("gross"),
      discount: order.discount || 0,
      coupon: order.coupon || null,
      payable,
    },
    amountInWords: amountInWords(payable),
  });
});

// Packing slip (FR-CHK-05): what goes in the box. Honours the gift option —
// when hideInvoiceValue is set, no prices appear anywhere on the slip (the
// tax invoice still exists separately for records).
app.get("/api/orders/:orderId/packing-slip", (req, res) => {
  const isAdmin =
    req.headers["x-admin-key"] === ADMIN_KEY || req.query.key === ADMIN_KEY;
  const order = db.orders.find(
    (o) => o.orderId.toUpperCase() === String(req.params.orderId).trim().toUpperCase()
  );
  if (!order || (!isAdmin && order.customer.phone !== String(req.query.phone || "").trim()))
    return res.status(404).json({ error: "No order found for that ID and mobile number." });

  const showPrices = !order.gift?.hideInvoiceValue;
  res.json({
    orderId: order.orderId,
    placedAt: order.placedAt,
    status: order.status,
    seller: { name: SELLER.name, address: SELLER.address, phone: SELLER.phone },
    deliverTo: {
      name: order.customer.name,
      address: order.customer.address,
      pincode: order.customer.pincode,
    },
    fulfilment: order.fulfilment || { method: "ship", store: null },
    gift: order.gift ? { wrap: true, message: order.gift.message || null } : null,
    showPrices,
    lines: order.lines.map((l) => ({
      name: l.name,
      size: l.size,
      variantNote: l.variantNote || null,
      engraving: l.engraving || null,
      qty: l.qty,
      huid: l.huid || null,
      lineTotal: showPrices ? l.lineTotal : null,
    })),
    payable: showPrices ? order.payable ?? order.total : null,
    codDue: order.payment.mode === "cod" && order.payment.status !== "refunded"
      ? (showPrices ? order.payable ?? order.total : null)
      : 0,
  });
});

// Notification log for the back office (FR-NOT / FR-RPT).
app.get("/api/admin/notifications", requireAdmin, (req, res) => {
  const { event, phone } = req.query;
  let list = [...db.notifications].reverse();
  if (event) list = list.filter((n) => n.event === event);
  if (phone) list = list.filter((n) => n.phone === String(phone).trim());
  res.json({
    events: [...new Set(db.notifications.map((n) => n.event))].sort(),
    total: list.length,
    notifications: list.slice(0, 200),
  });
});

app.post("/api/newsletter", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: "Enter a valid email address." });
  if (!db.newsletter.includes(email)) {
    db.newsletter.push(email);
    save();
  }
  res.json({ ok: true, message: "Welcome to the atelier. Letters arrive monthly." });
});

// ------------------------------------------------------------------ admin
// Two ways into the back office: the master key (env ADMIN_KEY — full
// access, kept for bootstrap and ops) or a personal admin account
// (email + password → a DB-backed session token). Sessions live in the
// store, so deleting a row or disabling the account locks that person
// out on their very next request.
const ADMIN_PERMISSIONS = Object.freeze([
  "dashboard", "orders", "customers", "rates", "catalogue", "schemes",
  "returns", "appointments", "callbacks", "promos", "buyback", "enquiries",
  "notifications", "settings", "admin-users",
]);
const ADMIN_SESSION_DAYS = 7;

if (!Array.isArray(db.adminUsers)) db.adminUsers = [];
if (!db.adminSessions || typeof db.adminSessions !== "object") db.adminSessions = {};

// scrypt with a per-user salt — built into node, timing-safe compare
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, "hex");
  return known.length === check.length && crypto.timingSafeEqual(check, known);
}
function safeAdmin(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

// First boot seeds the owner with every tile. Idempotent — an existing
// account (and its password) is never touched on restart.
if (db.adminUsers.length === 0) {
  db.adminUsers.push({
    id: crypto.randomUUID(),
    name: process.env.DPJ_OWNER_NAME || "Portal Owner",
    email: String(process.env.DPJ_OWNER_EMAIL || "owner@dpjewellers.example").toLowerCase(),
    passwordHash: hashPassword(process.env.DPJ_OWNER_PASSWORD || "Dpj@2026!"),
    permissions: [...ADMIN_PERMISSIONS],
    status: "Active",
    createdAt: new Date().toISOString(),
    lastLogin: null,
  });
  save();
}

// Which tile guards which admin route — enforced inside requireAdmin so
// every existing endpoint is covered without editing each one. Paths not
// listed (uploads, login/logout/me) just need any valid admin.
const ADMIN_ROUTE_TILES = [
  [/^\/(orders)/, "orders"],
  [/^\/(customers)/, "customers"],
  [/^\/(rates)/, "rates"],
  [/^\/(products)/, "catalogue"],
  [/^\/(schemes|scheme-variants)/, "schemes"],
  [/^\/returns/, "returns"],
  [/^\/appointments/, "appointments"],
  [/^\/callbacks/, "callbacks"],
  [/^\/coupons/, "promos"],
  [/^\/buyback/, "buyback"],
  [/^\/enquiries/, "enquiries"],
  [/^\/notifications/, "notifications"],
  [/^\/(summary|abandoned|analytics|audit)/, "dashboard"],
  [/^\/(config|content|stores|emi-plans|discount-rules|backup|categories)/, "settings"],
  [/^\/users/, "admin-users"],
];
function tileForAdminPath(path) {
  const p = String(path).replace(/^\/api\/admin/, "");
  const hit = ADMIN_ROUTE_TILES.find(([re]) => re.test(p));
  return hit ? hit[1] : null;
}

function adminFromToken(token) {
  const s = db.adminSessions[token];
  if (!s) return { error: "Admin session no longer active", code: 401 };
  if (Date.parse(s.expiresAt) < Date.now()) {
    delete db.adminSessions[token]; // lazy cleanup of expired rows
    save();
    return { error: "Admin session no longer active", code: 401 };
  }
  const user = db.adminUsers.find((u) => u.id === s.adminId);
  if (!user) return { error: "Admin session no longer active", code: 401 };
  if (user.status !== "Active") return { error: "Admin account is not active", code: 403 };
  return { user };
}

function requireAdmin(req, res, next) {
  let admin;
  if (req.headers["x-admin-key"] === ADMIN_KEY) {
    admin = { id: "master-key", name: "Master key", email: null, permissions: [...ADMIN_PERMISSIONS], master: true };
  } else {
    const bearer = String(req.headers.authorization || "");
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not authorised" });
    const got = adminFromToken(token);
    if (got.error) return res.status(got.code).json({ error: got.error });
    admin = safeAdmin(got.user);
    req.adminToken = token;
  }
  const tile = tileForAdminPath(req.path);
  if (tile && !admin.permissions.includes(tile))
    return res.status(403).json({ error: `Requires permission: ${tile}` });
  req.adminUser = admin;
  next();
}

// CSV/backup downloads are plain links — they authenticate via ?key=
// (master) or ?token= (admin session), with the same tile check.
function exportAuthed(req, res, tile) {
  if (req.query.key === ADMIN_KEY) return true;
  const got = adminFromToken(String(req.query.token || ""));
  if (got.error) {
    res.status(401).send("Not authorised");
    return false;
  }
  if (tile && !got.user.permissions.includes(tile)) {
    res.status(403).send(`Requires permission: ${tile}`);
    return false;
  }
  return true;
}

// Global admin audit trail (FR-ADM) — every back-office mutation lands here.
// The rate console keeps its own richer db.rateAudit as well.
if (!Array.isArray(db.adminAudit)) db.adminAudit = [];
function audit(action, detail) {
  db.adminAudit.push({ at: new Date().toISOString(), action, detail });
  if (db.adminAudit.length > 1000)
    db.adminAudit.splice(0, db.adminAudit.length - 1000);
  // callers persist via their own save()
}

app.get("/api/admin/audit", requireAdmin, (req, res) => {
  res.json([...db.adminAudit].slice(-100).reverse());
});

// Business rules — read + guarded edit (FR-ADM-08).
app.get("/api/admin/config", requireAdmin, (req, res) => {
  res.json({ config, fields: CONFIG_FIELDS });
});

app.patch("/api/admin/config", requireAdmin, (req, res) => {
  const changes = [];
  for (const [key, raw] of Object.entries(req.body || {})) {
    // Delivery area: lat/lng are decimals and may be blank (= check disabled)
    if (key === "deliveryLat" || key === "deliveryLng") {
      const bound = key === "deliveryLat" ? 90 : 180;
      let value = null;
      if (raw !== "" && raw !== null && raw !== undefined) {
        value = Number(raw);
        if (!Number.isFinite(value) || Math.abs(value) > bound)
          return res.status(400).json({
            error: `${key === "deliveryLat" ? "Latitude" : "Longitude"} must be between -${bound} and ${bound} — or blank to disable the radius check.`,
          });
      }
      if (config[key] !== value) changes.push({ key, from: config[key], to: value });
      continue;
    }
    if (key === "deliveryRadiusKm") {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 2000)
        return res.status(400).json({ error: "Delivery radius must be a whole number between 1 and 2000 km." });
      if (config[key] !== value) changes.push({ key, from: config[key], to: value });
      continue;
    }
    // Order policy: the cancellation cutoff is a status name, not a number
    if (key === "cancelCutoffStatus") {
      const value = String(raw || "").trim();
      if (!ORDER_FLOW.slice(1).includes(value))
        return res.status(400).json({
          error: `Cancellation cutoff must be one of: ${ORDER_FLOW.slice(1).join(", ")}.`,
        });
      if (config[key] !== value) changes.push({ key, from: config[key], to: value });
      continue;
    }
    const field = CONFIG_FIELDS.find((f) => f.key === key);
    if (!field) return res.status(400).json({ error: `"${key}" is not an editable setting.` });
    const value = Number(raw);
    if (!Number.isInteger(value) || value < field.min || value > field.max)
      return res.status(400).json({
        error: `${field.label} must be a whole number between ${field.min.toLocaleString("en-IN")} and ${field.max.toLocaleString("en-IN")}.`,
      });
    if (config[key] !== value) changes.push({ key, from: config[key], to: value });
  }
  if (changes.length === 0) return res.json({ ok: true, config, changed: 0 });
  for (const c of changes) config[c.key] = c.to;
  audit("settings", changes.map((c) => `${c.key}: ${c.from} → ${c.to}`).join(", "));
  save();
  res.json({ ok: true, config, changed: changes.length });
});

// Site content managed from the admin — homepage hero media (FR-CMS).
// Either a full https:// URL or a /path served by the frontend; the video,
// when set, plays instead of the image.
const DEFAULT_CONTENT = {
  heroImage: "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?q=80&w=1600&auto=format&fit=crop",
  heroVideo: "",
  // homepage promotion slides: [{ image, slug }] — each image may link to a
  // product; the hero rotates through them (the video, when set, wins)
  heroSlides: [],
  // category-wise sale banners: [{ image, category, alt, on, hMobile, hDesktop }]
  // — a marquee under the hero; tapping opens that category in the shop.
  // category "" (or an unknown key) falls back to the full collection.
  promoBanners: [],
  companyName: "DP Jewellers",
  companyTagline: "Fine Jewellery",
  heroEyebrow: "Est. 1962 · BIS Hallmarked",
  heroLine1: "Light,",
  heroLine2: "Rendered",
  heroLine3: "Eternal.",
  heroSub:
    "Hand-set diamonds and 22K gold, priced live on today's rate and composed by our atelier — three generations in the making.",
  // customer support channels — blank hides that channel on the storefront
  supportPhone: "",
  supportWhatsapp: "",
  supportEmail: "",
  supportMessage: "",
  // order policy copy shown on the tracking page — blank hides the line
  returnPolicyMessage: "",
  // site-wide background theme (Appearance setting) — a key from SITE_THEMES
  theme: "heritage",
  // optional picture behind the whole site (Appearance setting) — shown under
  // a translucent wash of the theme's surface colour; blank = plain theme
  backgroundImage: "",
  // optional pictures behind the header bar and the footer (Header & footer
  // setting) — each under the same readability wash; blank = plain surface
  headerBgImage: "",
  footerBgImage: "",
  // header navigation and footer structure (Header & footer setting).
  // Empty arrays restore these defaults; paths are /internal or https://.
  navLinks: [
    { label: "Home", path: "/" },
    { label: "Shop", path: "/shop" },
    { label: "Gold Scheme", path: "/gold-scheme" },
    { label: "Custom", path: "/custom" },
    { label: "The House", path: "/#maison" },
  ],
  footerBlurb:
    "Three generations of goldsmiths. Every piece BIS-hallmarked with HUID, certified, and priced transparently on the day's metal rate.",
  footerColumns: [
    {
      title: "Shop",
      links: [
        { label: "Rings", path: "/shop?category=rings" },
        { label: "Necklaces", path: "/shop?category=necklaces" },
        { label: "Earrings", path: "/shop?category=earrings" },
        { label: "Bangles & Bracelets", path: "/shop?category=bangles,bracelets" },
        { label: "Mangalsutra", path: "/shop?category=mangalsutra" },
      ],
    },
    {
      title: "Client Services",
      links: [
        { label: "Track an order", path: "/track" },
        { label: "Gold savings scheme", path: "/gold-scheme" },
        { label: "Returns & exchange", path: "/track" },
        { label: "Old-gold exchange & buyback", path: "/old-gold" },
        { label: "Custom & made-to-order", path: "/custom" },
        { label: "Buying guides", path: "/guides" },
        { label: "My account", path: "/account" },
      ],
    },
    {
      title: "The House",
      links: [
        { label: "Our story", path: "/#maison" },
        { label: "Showrooms", path: "/stores" },
        { label: "Book an appointment", path: "/appointments" },
      ],
    },
  ],
};
// Curated background palettes the storefront ships CSS for — free-form
// values are refused so the admin can't pick a look that doesn't exist.
const SITE_THEMES = ["heritage", "pearl", "champagne", "sage", "blush", "midnight"];
if (!db.content || typeof db.content !== "object") db.content = {};
db.content = Object.assign({}, DEFAULT_CONTENT, db.content);

app.get("/api/content", (req, res) => res.json(db.content));

// Media uploads from the admin's computer (hero image/video). Stored on disk
// under backend/uploads and served at /api/uploads/... (rides the dev proxy).
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Brand media committed to the repo (seed-media/) is copied into the uploads
// store on every boot — hosts with ephemeral disks (Render free tier) wipe
// uploads/ on each restart, so these stable-named files are the only media
// URLs that survive unconditionally. Existing files are never overwritten,
// so an admin can replace one via the upload endpoint until the next restart.
const SEED_MEDIA_DIR = path.join(__dirname, "seed-media");
if (fs.existsSync(SEED_MEDIA_DIR)) {
  for (const f of fs.readdirSync(SEED_MEDIA_DIR)) {
    const dest = path.join(UPLOAD_DIR, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(SEED_MEDIA_DIR, f), dest);
  }
}
const UPLOAD_TYPES = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif",
};
app.use("/api/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", immutable: true }));

app.post(
  "/api/admin/uploads",
  requireAdmin,
  express.raw({ type: () => true, limit: "120mb" }),
  (req, res) => {
    const original = String(req.query.name || "").trim();
    const rawExt = path.extname(original);
    const ext = rawExt.toLowerCase();
    if (!UPLOAD_TYPES[ext])
      return res.status(400).json({
        error: `Unsupported file type "${ext || "(none)"}". Allowed: ${Object.keys(UPLOAD_TYPES).join(", ")}`,
      });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: "The upload arrived empty — pick the file again." });
    const base =
      path.basename(original, rawExt).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "media";
    const name = `${base}-${Date.now().toString(36)}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
    audit("upload", `${name} (${(req.body.length / (1024 * 1024)).toFixed(1)} MB)`);
    save();
    res.status(201).json({ url: `/api/uploads/${name}`, bytes: req.body.length });
  }
);

const CONTENT_URL_FIELDS = ["heroImage", "heroVideo", "backgroundImage", "headerBgImage", "footerBgImage"];
// editable copy, with per-field length caps; empty = back to the house default
const CONTENT_TEXT_LIMITS = {
  companyName: 40,
  companyTagline: 60,
  heroEyebrow: 70,
  heroLine1: 30,
  heroLine2: 30,
  heroLine3: 30,
  heroSub: 240,
  supportPhone: 20,
  supportWhatsapp: 20,
  supportEmail: 80,
  supportMessage: 500,
  returnPolicyMessage: 500,
  footerBlurb: 300,
};
// fields where empty means "hidden/off", not "restore the house default"
// (heroImage may stay blank — e.g. when a video is the hero — the storefront
// falls back to its built-in image only if the video is also unset; hero
// wording saved blank simply doesn't render, so a media-only hero is possible)
const CONTENT_BLANK_OK = new Set([
  "heroImage", "heroVideo", "backgroundImage", "headerBgImage", "footerBgImage",
  "heroEyebrow", "heroLine1", "heroLine2", "heroLine3", "heroSub",
  "supportPhone", "supportWhatsapp", "supportEmail", "supportMessage",
  "returnPolicyMessage",
]);

app.patch("/api/admin/content", requireAdmin, (req, res) => {
  const changes = [];
  for (const [key, raw] of Object.entries(req.body || {})) {
    // header nav / footer columns are structured lists, not strings.
    // An empty array restores the house default.
    if (key === "navLinks" || key === "footerColumns") {
      if (!Array.isArray(raw))
        return res.status(400).json({ error: `${key} must be a list.` });
      const LINK_RE = /^(\/[^\s"']*|https?:\/\/[^\s"']+)$/i;
      const cleanLink = (l, labelMax) => {
        const label = String(l?.label || "").trim();
        const path = String(l?.path || "").trim();
        if (!label || label.length > labelMax) return null;
        if (!LINK_RE.test(path) || path.length > 300) return null;
        return { label, path };
      };
      let value;
      if (raw.length === 0) {
        value = structuredClone(DEFAULT_CONTENT[key]);
      } else if (key === "navLinks") {
        if (raw.length > 7)
          return res.status(400).json({ error: "Up to 7 header links keep the navigation elegant." });
        value = raw.map((l) => cleanLink(l, 24));
        if (value.some((l) => !l))
          return res.status(400).json({
            error: "Each header link needs a label (up to 24 characters) and a /path or https:// URL.",
          });
      } else {
        if (raw.length > 4)
          return res.status(400).json({ error: "Up to 4 footer columns." });
        value = [];
        for (const col of raw) {
          const title = String(col?.title || "").trim();
          if (!title || title.length > 30)
            return res.status(400).json({ error: "Each footer column needs a title (up to 30 characters)." });
          if (!Array.isArray(col?.links) || col.links.length < 1 || col.links.length > 8)
            return res.status(400).json({ error: `Column ${title || "?"} needs 1 to 8 links.` });
          const links = col.links.map((l) => cleanLink(l, 40));
          if (links.some((l) => !l))
            return res.status(400).json({
              error: `Column ${title}: each link needs a label (up to 40 characters) and a /path or https:// URL.`,
            });
          value.push({ title, links });
        }
      }
      if (JSON.stringify(db.content[key] || []) !== JSON.stringify(value))
        changes.push({ key, to: value, label: `${value.length} ${key === "navLinks" ? "links" : "columns"}` });
      continue;
    }
    // appearance: only curated theme keys exist in the storefront CSS
    if (key === "theme") {
      const value = String(raw || "").trim() || "heritage";
      if (!SITE_THEMES.includes(value))
        return res.status(400).json({
          error: `Unknown theme "${value}". Available: ${SITE_THEMES.join(", ")}.`,
        });
      if (db.content.theme !== value) changes.push({ key, to: value });
      continue;
    }
    // promotion slides are structured, not a string
    if (key === "heroSlides") {
      if (!Array.isArray(raw))
        return res.status(400).json({ error: "heroSlides must be a list of slides." });
      if (raw.length > 6)
        return res.status(400).json({ error: "Up to 6 promotion slides on the homepage." });
      const slides = [];
      for (const s of raw) {
        const image = String(s?.image || "").trim();
        const slug = String(s?.slug || "").trim();
        if (!/^(https?:\/\/|\/)[^\s"']+$/i.test(image) || image.length > 600)
          return res.status(400).json({
            error: "Each slide needs an image (https://… or a /path on this site).",
          });
        if (slug && !published().some((p) => p.slug === slug))
          return res.status(400).json({ error: `"${slug}" is not a published product.` });
        slides.push({ image, slug: slug || null });
      }
      if (JSON.stringify(db.content.heroSlides || []) !== JSON.stringify(slides))
        changes.push({ key, to: slides, label: `${slides.length} slide${slides.length === 1 ? "" : "s"}` });
      continue;
    }
    // category-wise sale banners (Settings → Category promotions)
    if (key === "promoBanners") {
      if (!Array.isArray(raw))
        return res.status(400).json({ error: "promoBanners must be a list of banners." });
      if (raw.length > 6)
        return res.status(400).json({ error: "Up to 6 promotion banners." });
      const banners = [];
      for (const b of raw) {
        const image = String(b?.image || "").trim();
        const category = String(b?.category || "").trim().toLowerCase().slice(0, 30);
        const alt = String(b?.alt || "").trim().slice(0, 80);
        const hMobile = Math.round(Number(b?.hMobile) || 0);
        const hDesktop = Math.round(Number(b?.hDesktop) || 0);
        if (!/^(https?:\/\/|\/)[^\s"']+$/i.test(image) || image.length > 600)
          return res.status(400).json({
            error: "Each banner needs an image (https://… or a /path on this site).",
          });
        if ((hMobile && (hMobile < 40 || hMobile > 600)) || (hDesktop && (hDesktop < 40 || hDesktop > 600)))
          return res.status(400).json({ error: "Banner heights must be 40–600 px (blank for auto)." });
        banners.push({ image, category, alt, on: b?.on === false ? false : true, hMobile, hDesktop });
      }
      if (JSON.stringify(db.content.promoBanners || []) !== JSON.stringify(banners)) {
        const live = banners.filter((b) => b.on).length;
        changes.push({ key, to: banners, label: `${live} of ${banners.length} banner${banners.length === 1 ? "" : "s"} live` });
      }
      continue;
    }
    const value = String(raw || "").trim();
    if (CONTENT_URL_FIELDS.includes(key)) {
      if (value && !/^(https?:\/\/|\/)[^\s"']+$/i.test(value))
        return res.status(400).json({
          error: `${key} must be a full https:// URL (or a /path on this site) — or empty to clear it.`,
        });
      if (value.length > 600)
        return res.status(400).json({ error: `${key} is too long (600 characters max).` });
    } else if (key in CONTENT_TEXT_LIMITS) {
      if (value.length > CONTENT_TEXT_LIMITS[key])
        return res.status(400).json({
          error: `${key} is too long (${CONTENT_TEXT_LIMITS[key]} characters max).`,
        });
      if ((key === "supportPhone" || key === "supportWhatsapp") && value && !/^\+?[\d\s\-()]{8,20}$/.test(value))
        return res.status(400).json({
          error: `${key === "supportPhone" ? "Support phone" : "WhatsApp number"} should be digits with an optional country code — spaces and dashes are fine.`,
        });
      if (key === "supportEmail" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value))
        return res.status(400).json({ error: "Support email doesn't look like an email address." });
    } else {
      return res.status(400).json({ error: `"${key}" is not an editable content field.` });
    }
    if (db.content[key] !== value) changes.push({ key, to: value });
  }
  if (changes.length === 0) return res.json({ ok: true, content: db.content, changed: 0 });
  for (const c of changes) db.content[c.key] = c.to;
  // empty text/image fields fall back to the house defaults (blank-ok fields stay empty)
  for (const key of Object.keys(DEFAULT_CONTENT))
    if (!CONTENT_BLANK_OK.has(key) && !db.content[key]) db.content[key] = DEFAULT_CONTENT[key];
  audit("content", changes.map((c) => `${c.key} → ${c.label || c.to || "(reset to default)"}`).join(", "));
  save();
  res.json({ ok: true, content: db.content, changed: changes.length });
});

// Full operational snapshot for offline backup (pair with pg_dump for the
// database-level backup; this one is human-readable and restorable by hand).
app.get("/api/admin/export/backup.json", (req, res) => {
  if (!exportAuthed(req, res, "settings")) return;
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="dpj-backup-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json({ exportedAt: new Date().toISOString(), collections: db });
});

// In-memory brute-force guard: 5 failures → 60 s lockout per client.
const adminFailures = new Map();
app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || "unknown";
  const failed = adminFailures.get(ip);
  if (failed && failed.until > Date.now())
    return res.status(429).json({ error: "Too many attempts — try again in a minute." });
  const fail = (status, message) => {
    const count = (failed?.count || 0) + 1;
    adminFailures.set(ip, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
    return res.status(status).json({ error: message });
  };

  const { key, email, password } = req.body || {};
  // master-key path (unchanged behaviour)
  if (email === undefined && password === undefined) {
    if (key !== ADMIN_KEY) return fail(401, "Wrong admin key");
    adminFailures.delete(ip);
    return res.json({ ok: true });
  }

  // account sign-in — unknown email and wrong password answer identically
  const user = db.adminUsers.find((u) => u.email === String(email || "").trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ""), user.passwordHash))
    return fail(401, "Invalid email or password");
  if (user.status !== "Active") return fail(401, "Admin account is not active");
  adminFailures.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  db.adminSessions[token] = {
    adminId: user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ADMIN_SESSION_DAYS * 864e5).toISOString(),
  };
  user.lastLogin = now.toISOString();
  audit("admin-login", `${user.email} signed in (${ip})`);
  save();
  res.json({ ok: true, admin: safeAdmin(user), token });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  if (req.adminToken) {
    delete db.adminSessions[req.adminToken];
    save();
  }
  res.json({ ok: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) =>
  res.json({ admin: req.adminUser, catalog: ADMIN_PERMISSIONS })
);

app.patch("/api/admin/me", requireAdmin, (req, res) => {
  if (req.adminUser.master)
    return res.status(400).json({ error: "The master key has no profile to edit." });
  const name = String(req.body?.name || "").trim();
  if (name.length < 2 || name.length > 100)
    return res.status(400).json({ error: "Name must be 2–100 characters." });
  const user = db.adminUsers.find((u) => u.id === req.adminUser.id);
  user.name = name;
  save();
  res.json({ ok: true, admin: safeAdmin(user) });
});

app.patch("/api/admin/me/password", requireAdmin, (req, res) => {
  if (req.adminUser.master)
    return res.status(400).json({ error: "The master key has no password to change here." });
  const user = db.adminUsers.find((u) => u.id === req.adminUser.id);
  if (!verifyPassword(String(req.body?.currentPassword || ""), user.passwordHash))
    return res.status(401).json({ error: "Current password is incorrect." });
  const errors = passwordErrors(String(req.body?.newPassword || ""));
  if (errors.length)
    return res.status(400).json({ error: "Invalid request body", details: { fieldErrors: { newPassword: errors } } });
  user.passwordHash = hashPassword(String(req.body.newPassword));
  // every OTHER session of this admin ends; the current one stays signed in
  for (const [t, s] of Object.entries(db.adminSessions))
    if (s.adminId === user.id && t !== req.adminToken) delete db.adminSessions[t];
  audit("admin-password", `${user.email} changed their password`);
  save();
  res.json({ ok: true });
});

// ------------------------------------------- Admin Users (tile: admin-users)
// The most privileged corner of the portal: create colleagues, hand out
// dashboard tiles, reset passwords, disable accounts. Soft-delete only —
// rows are never removed, so the audit history keeps its names.
function passwordErrors(pw) {
  const errors = [];
  if (pw.length < 8) errors.push("Min 8 characters");
  if (!/[A-Z]/.test(pw)) errors.push("Needs an uppercase letter");
  if (!/\d/.test(pw)) errors.push("Needs a number");
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push("Needs a special character");
  return errors;
}
function cleanPermissions(list) {
  if (!Array.isArray(list)) return null;
  const set = [...new Set(list.map((p) => String(p)))].filter((p) => ADMIN_PERMISSIONS.includes(p));
  set.sort((a, b) => ADMIN_PERMISSIONS.indexOf(a) - ADMIN_PERMISSIONS.indexOf(b));
  return set;
}
const activeGatekeepers = () =>
  db.adminUsers.filter((u) => u.status === "Active" && u.permissions.includes("admin-users")).length;
const purgeSessions = (adminId) => {
  for (const [t, s] of Object.entries(db.adminSessions)) if (s.adminId === adminId) delete db.adminSessions[t];
};
const byLine = (req) => `${req.adminUser.master ? "master key" : req.adminUser.email} @ ${req.ip || "?"}`;

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const { q, permission, status } = req.query;
  let rows = [...db.adminUsers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(needle));
  }
  if (permission) rows = rows.filter((u) => u.permissions.includes(String(permission)));
  if (status && ["Active", "Disabled"].includes(String(status)))
    rows = rows.filter((u) => u.status === status);
  const total = rows.length;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(totalPages, Math.max(1, Number(req.query.page) || 1));
  res.json({
    users: rows.slice((page - 1) * limit, page * limit).map(safeAdmin),
    meta: { page, limit, total, totalPages },
    catalog: ADMIN_PERMISSIONS,
  });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const b = req.body || {};
  const fieldErrors = {};
  const name = String(b.name || "").trim();
  if (name.length < 2 || name.length > 100) fieldErrors.name = ["Name must be 2–100 characters"];
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 150)
    fieldErrors.email = ["Enter a valid email address"];
  const pwErrors = passwordErrors(String(b.password || ""));
  if (pwErrors.length) fieldErrors.password = pwErrors;
  const permissions = cleanPermissions(b.permissions);
  if (!permissions || permissions.length === 0)
    fieldErrors.permissions = ["Pick at least one dashboard tile"];
  if (Object.keys(fieldErrors).length)
    return res.status(400).json({ error: "Invalid request body", details: { fieldErrors } });
  if (db.adminUsers.some((u) => u.email === email))
    return res.status(409).json({ error: "Admin with that email already exists" });

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(String(b.password)),
    permissions,
    status: "Active",
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };
  db.adminUsers.push(user);
  audit("admin-user-create", `${email} [${permissions.join(", ")}] by ${byLine(req)}`);
  save();
  res.status(201).json({ ok: true, user: safeAdmin(user) });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const target = db.adminUsers.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "Admin not found" });
  const b = req.body || {};
  if (b.name === undefined && b.permissions === undefined && b.status === undefined)
    return res.status(400).json({ error: "No fields to update" });
  const self = req.adminUser.id === target.id;
  const changes = [];

  let name;
  if (b.name !== undefined) {
    name = String(b.name).trim();
    if (name.length < 2 || name.length > 100)
      return res.status(400).json({ error: "Invalid request body", details: { fieldErrors: { name: ["Name must be 2–100 characters"] } } });
    if (name !== target.name) changes.push(`name → ${name}`);
  }

  let permissions;
  if (b.permissions !== undefined) {
    permissions = cleanPermissions(b.permissions);
    if (!permissions || permissions.length === 0)
      return res.status(400).json({ error: "Invalid request body", details: { fieldErrors: { permissions: ["Pick at least one dashboard tile"] } } });
    const changed = JSON.stringify(permissions) !== JSON.stringify(target.permissions);
    if (changed && self)
      return res.status(400).json({ error: "You cannot change your own permissions" });
    if (
      changed &&
      target.status === "Active" &&
      target.permissions.includes("admin-users") &&
      !permissions.includes("admin-users") &&
      activeGatekeepers() <= 1
    )
      return res.status(400).json({ error: "Cannot remove the Admin Users permission from the only admin who has it" });
    if (changed) changes.push(`tiles → ${permissions.join(", ")}`);
  }

  let status;
  if (b.status !== undefined) {
    status = String(b.status);
    if (!["Active", "Disabled"].includes(status))
      return res.status(400).json({ error: "Status must be Active or Disabled" });
    const changed = status !== target.status;
    if (changed && self)
      return res.status(400).json({ error: "You cannot change your own status" });
    if (
      changed &&
      status === "Disabled" &&
      target.permissions.includes("admin-users") &&
      activeGatekeepers() <= 1
    )
      return res.status(400).json({ error: "Cannot disable the only admin who can manage admin accounts" });
    if (changed) changes.push(`status → ${status}`);
  }

  if (name !== undefined) target.name = name;
  if (permissions !== undefined) target.permissions = permissions;
  if (status !== undefined) target.status = status;
  if (status === "Disabled") purgeSessions(target.id); // instant kick-out
  if (changes.length) audit("admin-user-update", `${target.email}: ${changes.join("; ")} by ${byLine(req)}`);
  save();
  res.json({ ok: true, user: safeAdmin(target) });
});

app.patch("/api/admin/users/:id/password", requireAdmin, (req, res) => {
  const target = db.adminUsers.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "Admin not found" });
  if (req.adminUser.id === target.id)
    return res.status(400).json({ error: "Use the change-password option on your own profile instead" });
  const errors = passwordErrors(String(req.body?.password || ""));
  if (errors.length)
    return res.status(400).json({ error: "Invalid request body", details: { fieldErrors: { password: errors } } });
  target.passwordHash = hashPassword(String(req.body.password));
  purgeSessions(target.id); // they sign in fresh with the new password
  audit("admin-user-password-reset", `${target.email} by ${byLine(req)}`);
  save();
  res.json({ ok: true });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const target = db.adminUsers.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "Admin not found" });
  if (req.adminUser.id === target.id)
    return res.status(400).json({ error: "You cannot disable your own account" });
  if (
    target.status === "Active" &&
    target.permissions.includes("admin-users") &&
    activeGatekeepers() <= 1
  )
    return res.status(400).json({ error: "Cannot disable the only admin who can manage admin accounts" });
  target.status = "Disabled";
  purgeSessions(target.id);
  audit("admin-user-disable", `${target.email} by ${byLine(req)}`);
  save();
  res.json({ ok: true });
});

app.get("/api/admin/export/admin-users.csv", (req, res) => {
  if (!exportAuthed(req, res, "admin-users")) return;
  const rows = [...db.adminUsers]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((u) => [u.id, u.name, u.email, u.status, u.permissions.join(", "), u.createdAt.slice(0, 10), u.lastLogin || ""]);
  rows.push([], ["Total admins", db.adminUsers.length], ["Active", db.adminUsers.filter((u) => u.status === "Active").length]);
  sendCsv(
    res,
    `dpj-admin-users-${new Date().toISOString().slice(0, 10)}.csv`,
    ["id", "name", "email", "status", "permissions", "created", "lastLogin"],
    rows
  );
});

app.get("/api/admin/summary", requireAdmin, (req, res) => {
  const orders = db.orders;
  const revenue = orders
    .filter((o) => !["Cancelled", "Refunded"].includes(o.status))
    .reduce((s, o) => s + (o.payable ?? o.total), 0);
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const searchAgg = {};
  for (const s of db.searchLog || []) {
    if (!searchAgg[s.term]) searchAgg[s.term] = { term: s.term, count: 0, zero: 0 };
    searchAgg[s.term].count += 1;
    if (s.results === 0) searchAgg[s.term].zero += 1;
  }
  const searchRows = Object.values(searchAgg);

  res.json({
    orders: orders.length,
    revenue,
    byStatus,
    pendingRateProposals: db.rateProposals.filter((p) => p.status === "pending").length,
    callbacksNew: (db.callbacks || []).filter((c) => c.status === "New").length,
    newsletterSubscribers: db.newsletter.length,
    skus: products.length,
    lowStock: products
      .filter((p) => Number.isFinite(p.stock) && p.stock <= config.lowStockThreshold)
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 8)
      .map((p) => ({ slug: p.slug, name: p.name, stock: p.stock })),
    notificationsSent: db.notifications.length,
    loyalty: {
      members: Object.keys(db.loyalty).length,
      pointsOutstanding: Object.values(db.loyalty).reduce((s, a) => s + a.points, 0),
      referralsEarned: db.referrals.filter((r) => r.status === "Earned").length,
    },
    providers: providers.status(),
    topSearches: [...searchRows].sort((a, b) => b.count - a.count).slice(0, 8),
    zeroResultSearches: searchRows.filter((r) => r.zero > 0).sort((a, b) => b.zero - a.zero).slice(0, 8),
    recentOrders: [...orders].slice(-6).reverse().map((o) => ({
      orderId: o.orderId,
      placedAt: o.placedAt,
      status: o.status,
      total: o.total,
      customer: o.customer.name,
    })),
  });
});

// Trading analytics computed from live order data (FR-RPT).
app.get("/api/admin/analytics", requireAdmin, (req, res) => {
  const valid = db.orders.filter((o) => !["Cancelled", "Refunded"].includes(o.status));

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const byDay = days.map((day) => {
    const dayOrders = valid.filter((o) => o.placedAt.slice(0, 10) === day);
    return {
      day,
      orders: dayOrders.length,
      revenue: dayOrders.reduce((s, o) => s + (o.payable ?? o.total), 0),
    };
  });

  const categoryRevenue = {};
  for (const o of valid) {
    for (const l of o.lines) {
      const product = products.find((p) => p.slug === l.slug);
      const cat = product?.category || "other";
      categoryRevenue[cat] = (categoryRevenue[cat] || 0) + l.lineTotal;
    }
  }

  const perPhone = {};
  for (const o of valid) perPhone[o.customer.phone] = (perPhone[o.customer.phone] || 0) + 1;
  const buyers = Object.keys(perPhone).length;
  const repeatBuyers = Object.values(perPhone).filter((n) => n >= 2).length;
  const revenue = valid.reduce((s, o) => s + (o.payable ?? o.total), 0);

  res.json({
    byDay,
    categories: Object.entries(categoryRevenue)
      .map(([category, value]) => ({ category, revenue: value }))
      .sort((a, b) => b.revenue - a.revenue),
    aov: valid.length ? Math.round(revenue / valid.length) : 0,
    buyers,
    repeatRatePct: buyers ? Math.round((repeatBuyers / buyers) * 100) : 0,
    couponsUsed: valid.filter((o) => o.coupon).length,
    giftOrders: valid.filter((o) => o.gift).length,
    pickupSharePct: valid.length
      ? Math.round((valid.filter((o) => o.fulfilment?.method === "pickup").length / valid.length) * 100)
      : 0,
  });
});

// Newest-first, with optional server-side filters and pagination. A call
// without page/limit returns the full list (existing consumers rely on it);
// meta.counts always covers ALL orders so the status chips stay stable
// while a filter narrows the table.
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const { q, customer, status, payment, from, to } = req.query;
  let orders = [...db.orders].reverse();
  if (q) orders = orders.filter((o) => o.orderId.toLowerCase().includes(String(q).toLowerCase()));
  if (customer) {
    const needle = String(customer).toLowerCase();
    orders = orders.filter((o) =>
      `${o.customer.name} ${o.customer.phone} ${o.customer.email || ""}`.toLowerCase().includes(needle)
    );
  }
  if (status) orders = orders.filter((o) => o.status === status);
  if (payment) orders = orders.filter((o) => o.payment.status === payment);
  if (from) orders = orders.filter((o) => o.placedAt.slice(0, 10) >= from);
  if (to) orders = orders.filter((o) => o.placedAt.slice(0, 10) <= to);

  const counts = {};
  for (const o of db.orders) counts[o.status] = (counts[o.status] || 0) + 1;

  const total = orders.length;
  let page = 1;
  let limit = total;
  let totalPages = 1;
  if (req.query.page !== undefined || req.query.limit !== undefined) {
    limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    totalPages = Math.max(1, Math.ceil(total / limit));
    page = Math.min(totalPages, Math.max(1, Number(req.query.page) || 1));
    orders = orders.slice((page - 1) * limit, page * limit);
  }

  res.json({
    flow: ORDER_FLOW,
    special: SPECIAL_STATUS,
    orders: orders.map((o) => ({ ...o, nextStatuses: nextStatuses(o.status) })),
    meta: { page, limit, total, totalPages, counts },
  });
});

// Shared by the admin console and customer-driven cancellation — the cutoff
// (canTransition) is checked by the caller; this applies the side effects.
function applyOrderTransition(order, to, by) {
  order.status = to;
  order.statusTimeline.push({ status: to, at: new Date().toISOString(), by });
  if (to === "Refunded") order.payment.status = "refunded";
  if (to === "Cancelled") adjustStock(order.lines, +1); // pieces return to the shelf
  if (invoiceEligible(order)) ensureInvoice(order);

  // DPJ Rewards: points accrue on delivery; a cancellation refunds any
  // points spent and voids a pending referral.
  const orderValue = order.payable ?? order.total;
  if (to === "Delivered") {
    const acc = loyaltyAccount(order.customer.phone);
    const beforeTier = tierOf(acc);
    const earned = Math.floor((orderValue / 100) * LOYALTY.earnPer100 * beforeTier.multiplier);
    if (earned > 0) {
      acc.points += earned;
      acc.ledger.push({ at: new Date().toISOString(), type: "earned", points: earned, orderId: order.orderId });
      notify(order.customer.phone, "rewards", `You earned ${earned} DPJ Rewards points on order ${order.orderId}. Balance: ${acc.points} points (₹${acc.points * LOYALTY.redeemValue} at checkout).`);
    }
    acc.lifetimeSpend += orderValue;
    const afterTier = tierOf(acc);
    if (afterTier.key !== beforeTier.key)
      notify(order.customer.phone, "rewards", `Welcome to ${afterTier.name}! You now earn ${afterTier.multiplier}× points on every purchase.`);
    const referral = db.referrals.find((r) => r.orderId === order.orderId && r.status === "Pending");
    if (referral) {
      referral.status = "Earned";
      referral.resolvedAt = new Date().toISOString();
      const refAcc = loyaltyAccount(referral.referrerPhone);
      refAcc.points += LOYALTY.referralBonusPoints;
      refAcc.ledger.push({ at: referral.resolvedAt, type: "referral", points: LOYALTY.referralBonusPoints, orderId: order.orderId });
      notify(referral.referrerPhone, "rewards", `Your referral just completed their first order — ${LOYALTY.referralBonusPoints} points added. Balance: ${refAcc.points}.`);
    }
  }
  if (to === "Cancelled") {
    if (order.loyalty?.points) {
      const acc = loyaltyAccount(order.customer.phone);
      acc.points += order.loyalty.points;
      acc.ledger.push({ at: new Date().toISOString(), type: "refunded", points: order.loyalty.points, orderId: order.orderId });
    }
    const referral = db.referrals.find((r) => r.orderId === order.orderId && r.status === "Pending");
    if (referral) referral.status = "Void";
  }

  const STATUS_MESSAGES = {
    Confirmed: `Order ${order.orderId} is confirmed. Your tax invoice is ready on the tracking page.`,
    "Under Quality Check": `Order ${order.orderId} is with our quality team — every piece is checked against its HUID before packing.`,
    Packed: `Order ${order.orderId} is packed and sealed in tamper-evident packaging.`,
    Shipped: `Order ${order.orderId} has shipped via insured courier. Track it at dpjewellers.example/track.`,
    "Out for Delivery": `Order ${order.orderId} is out for delivery today. Please keep an ID handy for the insured handover.`,
    Delivered:
      config.returnWindowDays > 0
        ? `Order ${order.orderId} is delivered. We hope it brings joy — returns are open for ${config.returnWindowDays} days.`
        : `Order ${order.orderId} is delivered. We hope it brings joy.`,
    Cancelled: `Order ${order.orderId} has been cancelled. Any payment made will be refunded to the source within 5–7 working days.`,
    Refunded: `Your refund for order ${order.orderId} has been processed to the original payment method.`,
  };
  if (STATUS_MESSAGES[to]) notify(order.customer.phone, "order-status", STATUS_MESSAGES[to]);
  audit("order-status", `${order.orderId}: → ${to} (${by})`);
  save();
}

app.patch("/api/admin/orders/:orderId/status", requireAdmin, (req, res) => {
  const order = db.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  const to = req.body?.status;
  if (!canTransition(order.status, to)) {
    const legal = nextStatuses(order.status);
    return res.status(400).json({
      error: `Cannot move from "${order.status}" to "${to}". ${legal.length ? `Legal next statuses: ${legal.join(", ")}.` : `"${order.status}" is a terminal status.`}`,
    });
  }
  const by = req.body?.by || "admin";
  const note = String(req.body?.note || "").trim().slice(0, 500) || null;

  // Open-box delivery photos — honoured only on the Delivered transition,
  // stamped server-side so the record says when and by whom.
  let photos = [];
  if (to === "Delivered" && Array.isArray(req.body?.deliveryPhotos)) {
    const at = new Date().toISOString();
    photos = req.body.deliveryPhotos
      .map((p) => String(p?.url || "").trim())
      .filter((u) => /^(https?:\/\/|\/)[^\s"']+$/i.test(u) && u.length <= 600)
      .slice(0, 8)
      .map((url) => ({ url, uploadedAt: at, uploadedBy: by }));
    if (photos.length) order.deliveryPhotos = (order.deliveryPhotos || []).concat(photos);
  }

  applyOrderTransition(order, to, by);

  // enrich the entry the transition just appended (timeline is append-only)
  const entry = order.statusTimeline[order.statusTimeline.length - 1];
  if (note) entry.note = note;
  if (photos.length) entry.photoCount = photos.length;
  if (to === "Delivered" && order.payment.mode === "cod" && order.payment.status !== "paid") {
    // cash collected at the doorstep — the delivery marks COD as paid
    order.payment.status = "paid";
    entry.paymentCollected = true;
    if (invoiceEligible(order)) ensureInvoice(order);
  }
  save();
  res.json({ ok: true, order: { ...order, nextStatuses: nextStatuses(order.status) } });
});

// Customer-driven cancellation (order policy): allowed strictly before the
// configured cutoff status; verified by orderId + the checkout phone number.
app.post("/api/orders/:orderId/cancel", (req, res) => {
  const order = db.orders.find(
    (o) => o.orderId.toUpperCase() === String(req.params.orderId || "").trim().toUpperCase()
  );
  if (!order || order.customer.phone !== String(req.body?.phone || "").trim())
    return res.status(404).json({ error: "No order found for that ID and mobile number." });
  if (order.status === "Cancelled")
    return res.status(400).json({ error: "This order is already cancelled." });
  if (!canTransition(order.status, "Cancelled"))
    return res.status(400).json({
      error: `Order ${order.orderId} is already ${order.status.toLowerCase()} — it can no longer be cancelled. Once delivered, you can request a return instead.`,
    });
  applyOrderTransition(order, "Cancelled", "customer");
  res.json({ ok: true, orderId: order.orderId, status: order.status });
});

// Live metal-rate feed (env METALS_API_KEY): purity rates derive from the
// fine-metal price; the same ±guard that protects manual proposals also
// blocks feed glitches. Manual maker-checker stays available regardless.
const PURITY_FACTORS = { "24K": 1, "22K": 0.916, "18K": 0.75, "14K": 0.583 };

async function runRateFeed() {
  if (providers.rateFeed.mode === "manual") return;
  try {
    const fine = await providers.rateFeed.fetchFineRates();
    const updates = [];
    const apply = (metal, purity, value) => {
      const current = db.rates[metal]?.[purity];
      if (current === undefined) return;
      const next = Math.round(value);
      const movePct = Math.abs((next - current) / current) * 100;
      if (movePct > config.rateGuardPct) {
        audit("rate-feed-guard", `${metal} ${purity}: feed ₹${next} is a ${movePct.toFixed(1)}% move — held for manual review`);
        return;
      }
      if (next !== current) {
        db.rates[metal][purity] = next;
        updates.push(`${metal} ${purity} ₹${current}→₹${next}`);
      }
    };
    for (const [purity, factor] of Object.entries(PURITY_FACTORS))
      apply("gold", purity, fine.gold24K * factor);
    apply("silver", "925", fine.silver * 0.925);
    apply("platinum", "PT950", fine.platinum * 0.95);
    if (updates.length) {
      db.ratesUpdatedAt = new Date().toISOString();
      audit("rate-feed", updates.join(", "));
    }
    save();
  } catch (e) {
    audit("rate-feed-error", e.message);
    save();
  }
}
runRateFeed();
setInterval(runRateFeed, 60 * 60 * 1000).unref();

// Rate console — maker-checker (BRD FR-ADM-02, FR-PRC-09/10/11).
app.get("/api/admin/rates", requireAdmin, (req, res) => {
  res.json({
    rates: db.rates,
    updatedAt: db.ratesUpdatedAt,
    proposals: [...db.rateProposals].reverse(),
    audit: [...db.rateAudit].slice(-30).reverse(),
    // chronological feed for the console's price-history chart
    history: db.rateAudit.slice(-400),
    guardPct: config.rateGuardPct,
    makerChecker: config.rateMakerChecker !== 0,
    purityFactors: PURITY_FACTORS,
  });
});

// Publish a proposal's rates — shared by checker approval and instant mode.
function publishProposal(proposal, checker) {
  proposal.status = "approved";
  proposal.checker = checker;
  proposal.resolvedAt = new Date().toISOString();
  const targets = proposal.targets || { [proposal.purity]: proposal.to };
  const lines = [];
  for (const [purity, to] of Object.entries(targets)) {
    const from = db.rates[proposal.metal][purity];
    db.rates[proposal.metal][purity] = to;
    db.rateAudit.push({
      at: proposal.resolvedAt,
      metal: proposal.metal,
      purity,
      from,
      to,
      maker: proposal.maker,
      checker,
    });
    lines.push(`${proposal.metal} ${purity}: ₹${from} → ₹${to}`);
  }
  db.ratesUpdatedAt = proposal.resolvedAt;
  audit("rate", `${lines.join(", ")} (maker ${proposal.maker}, checker ${checker})`);
}

app.post("/api/admin/rates/proposals", requireAdmin, (req, res) => {
  const { metal, purity, value, maker, note } = req.body || {};
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: "Enter a valid rate" });
  if (!maker) return res.status(400).json({ error: "Maker name is required" });

  // purity "ALL" (gold): enter the 24K fine rate once — 22K/18K/14K derive
  // via the same purity factors the live feed uses.
  let targets;
  if (metal === "gold" && purity === "ALL") {
    targets = {};
    for (const [p, factor] of Object.entries(PURITY_FACTORS)) targets[p] = Math.round(v * factor);
  } else {
    if (db.rates[metal]?.[purity] === undefined) return res.status(400).json({ error: "Unknown metal/purity" });
    targets = { [purity]: Math.round(v) };
  }

  // Margin guard (FR-PRC-11): block fat-finger moves beyond ±guardPct.
  for (const [p, to] of Object.entries(targets)) {
    const current = db.rates[metal][p];
    const movePct = Math.abs((to - current) / current) * 100;
    if (movePct > config.rateGuardPct)
      return res.status(400).json({
        error: `Guard blocked: ${metal} ${p} would move ${movePct.toFixed(1)}%. Proposals beyond ±${config.rateGuardPct}% need a config change.`,
      });
  }

  const single = !(metal === "gold" && purity === "ALL");
  const proposal = {
    id: newId("RP"),
    createdAt: new Date().toISOString(),
    metal,
    purity,
    from: single ? db.rates[metal][purity] : db.rates.gold["24K"],
    to: single ? targets[purity] : targets["24K"],
    targets: single ? null : targets,
    maker,
    note: note || null,
    status: "pending",
  };
  db.rateProposals.push(proposal);

  // Single-operator mode (config.rateMakerChecker = 0): publish immediately —
  // still guard-checked and fully audited.
  if (!config.rateMakerChecker) publishProposal(proposal, `${maker} (instant mode)`);

  save();
  res.status(201).json(proposal);
});

app.post("/api/admin/rates/proposals/:id/:action", requireAdmin, (req, res) => {
  const proposal = db.rateProposals.find((p) => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: "Proposal not found" });
  if (proposal.status !== "pending")
    return res.status(400).json({ error: `Proposal already ${proposal.status}` });

  const checker = req.body?.checker;
  if (!checker) return res.status(400).json({ error: "Checker name is required" });
  const action = req.params.action;

  if (action === "reject") {
    proposal.status = "rejected";
    proposal.checker = checker;
    proposal.resolvedAt = new Date().toISOString();
    save();
    return res.json(proposal);
  }
  if (action !== "approve") return res.status(400).json({ error: "Unknown action" });
  if (checker === proposal.maker)
    return res.status(400).json({ error: "Maker and checker must be different people." });

  publishProposal(proposal, checker);
  save();
  res.json(proposal);
});

// ---------------------------------------------------- gold savings scheme
// BRD 7.10. Instalments convert to grams at the day's 22K rate, so the
// customer accrues gold, not rupees. Terms acceptance is timestamped
// (FR-GSS-09); PAN is captured when the committed value crosses the
// statutory threshold (FR-GSS-02).
const DEFAULT_SCHEME_VARIANTS = [
  {
    key: "swarna-11-1",
    name: "Swarna 11+1",
    tenureMonths: 11,
    bonus: "12th instalment paid by DP Jewellers at redemption",
    minMonthly: 2000,
    blurb: "Pay 11 monthly instalments; the house adds the 12th. Redeem against any purchase.",
  },
  {
    key: "flexi-24",
    name: "Flexi Gold 24",
    tenureMonths: 24,
    bonus: "Making charges waived up to 50% at redemption",
    minMonthly: 1000,
    blurb: "A longer, lighter commitment that accrues grams every month for two years.",
  },
];
// Scheme plans live in the store (Admin → Settings → Gold scheme plans).
// Enrolled schemes reference their plan by key at read time, so the admin
// endpoint below keeps keys stable and refuses to drop a referenced plan.
if (!Array.isArray(db.schemeVariants) || db.schemeVariants.length === 0)
  db.schemeVariants = structuredClone(DEFAULT_SCHEME_VARIANTS);

if (!Array.isArray(db.schemes)) db.schemes = [];

app.patch("/api/admin/scheme-variants", requireAdmin, (req, res) => {
  const raw = req.body?.variants;
  if (!Array.isArray(raw))
    return res.status(400).json({ error: "Send variants as a list." });
  let clean;
  if (raw.length === 0) {
    clean = structuredClone(DEFAULT_SCHEME_VARIANTS);
  } else {
    if (raw.length > 6)
      return res.status(400).json({ error: "Keep it to 6 scheme plans or fewer." });
    clean = [];
    const seen = new Set();
    for (const entry of raw) {
      const name = String(entry?.name || "").trim().slice(0, 40);
      const tenureMonths = Math.round(Number(entry?.tenureMonths));
      const minMonthly = Math.round(Number(entry?.minMonthly));
      const bonus = String(entry?.bonus || "").trim().slice(0, 120);
      const blurb = String(entry?.blurb || "").trim().slice(0, 160);
      if (!name)
        return res.status(400).json({ error: "Every plan needs a name." });
      if (!Number.isFinite(tenureMonths) || tenureMonths < 3 || tenureMonths > 60)
        return res.status(400).json({ error: `Tenure for ${name} must be between 3 and 60 months.` });
      if (!Number.isFinite(minMonthly) || minMonthly < 500 || minMonthly > 100000)
        return res.status(400).json({ error: `Minimum instalment for ${name} must be ₹500 – ₹1,00,000.` });
      let key = String(entry?.key || "").trim();
      if (!key)
        key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "plan";
      while (seen.has(key)) key += "-2";
      seen.add(key);
      clean.push({ key, name, tenureMonths, bonus, minMonthly, blurb });
    }
  }
  // customers' running (or past) schemes must always find their plan
  const keys = new Set(clean.map((v) => v.key));
  const orphaned = [...new Set(db.schemes.filter((s) => !keys.has(s.variant)).map((s) => s.variant))];
  if (orphaned.length > 0)
    return res.status(400).json({
      error: `Customers hold schemes on: ${orphaned.join(", ")} — those plans can be renamed but not removed.`,
    });
  db.schemeVariants = clean;
  audit("schemes", `plans set: ${clean.map((v) => `${v.name} (${v.tenureMonths}mo)`).join(", ")}`);
  save();
  res.json({ ok: true, variants: db.schemeVariants });
});

function schemeView(s) {
  const rate22 = db.rates.gold["22K"];
  const variant = db.schemeVariants.find((v) => v.key === s.variant);
  const paid = s.instalments.length;
  const totalPaid = s.instalments.reduce((a, i) => a + i.amount, 0);
  const grams = s.instalments.reduce((a, i) => a + i.grams, 0);
  // The payment cycle anchors on the FIRST successful instalment, not the
  // enrolment moment — a scheme still awaiting activation has no due date.
  let nextDueAt = null;
  let maturityAt = null;
  let overdue = false;
  if (s.startedAt) {
    const start = new Date(s.startedAt);
    const maturity = new Date(start);
    maturity.setMonth(start.getMonth() + variant.tenureMonths);
    maturityAt = maturity.toISOString();
    if (s.status === "active") {
      const nextDue = new Date(start);
      nextDue.setMonth(start.getMonth() + paid);
      nextDueAt = nextDue.toISOString();
      overdue = nextDue.getTime() < Date.now();
    }
  }
  return {
    id: s.id,
    variant: s.variant,
    variantName: variant.name,
    bonus: variant.bonus,
    monthlyAmount: s.monthlyAmount,
    tenureMonths: variant.tenureMonths,
    status: s.status,
    displayStatus: s.status === "active" && overdue ? "overdue" : s.status,
    overdue,
    startedAt: s.startedAt || null,
    enrolledAt: s.enrolledAt || s.startedAt || null,
    paidCount: paid,
    remainingCount: Math.max(0, variant.tenureMonths - paid),
    totalPaid,
    gramsAccrued: Number(grams.toFixed(3)),
    currentValue: Math.round(grams * rate22),
    rate22,
    nextDueAt,
    maturityAt,
    instalments: s.instalments.map((i) => ({
      no: i.no, amount: i.amount, paidAt: i.paidAt, rate22K: i.rate22K, grams: i.grams,
      method: i.method || null,
    })),
    redemption: s.redemption || null,
  };
}

app.get("/api/schemes", (req, res) => res.json(db.schemeVariants));

app.post("/api/schemes/enroll", (req, res) => {
  const { variant, monthlyAmount, customer, acceptTerms } = req.body || {};
  const v = db.schemeVariants.find((x) => x.key === variant);
  if (!v) return res.status(400).json({ error: "Choose a scheme variant." });
  const amount = Number(monthlyAmount);
  if (!Number.isFinite(amount) || amount < v.minMonthly)
    return res.status(400).json({ error: `Minimum instalment for ${v.name} is ₹${v.minMonthly.toLocaleString("en-IN")}.` });
  if (!customer?.name || !/^[6-9]\d{9}$/.test(String(customer?.phone || "")))
    return res.status(400).json({ error: "Enter your name and a valid 10-digit mobile number." });
  if (acceptTerms !== true)
    return res.status(400).json({ error: "Please accept the scheme terms to enrol." });
  if (amount * v.tenureMonths >= config.panThreshold) {
    const pan = String(customer.pan || "").toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan))
      return res.status(400).json({ error: "PAN is required for this committed value (KYC)." });
  }

  // Enrolment reserves the scheme; it activates — and the monthly cycle
  // anchors — only when the FIRST instalment is paid successfully.
  const scheme = {
    id: newId("GSS"),
    variant: v.key,
    monthlyAmount: Math.round(amount),
    customer: {
      name: customer.name,
      phone: String(customer.phone),
      email: customer.email || null,
      pan: customer.pan ? String(customer.pan).toUpperCase() : null,
    },
    termsAcceptedAt: new Date().toISOString(),
    enrolledAt: new Date().toISOString(),
    startedAt: null,
    status: "pending",
    instalments: [],
  };
  db.schemes.push(scheme);
  notify(
    scheme.customer.phone,
    "scheme",
    `Welcome to ${v.name}! Pay the first instalment of ₹${scheme.monthlyAmount.toLocaleString("en-IN")} to activate scheme ${scheme.id} — every instalment converts to grams at that day's 22K rate.`
  );
  save();
  res.status(201).json(schemeView(scheme));
});

app.get("/api/schemes/my", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter the 10-digit mobile used at enrolment." });
  res.json(db.schemes.filter((s) => s.customer.phone === phone).map(schemeView));
});

app.post("/api/schemes/:id/pay", (req, res) => {
  const scheme = db.schemes.find((s) => s.id === req.params.id);
  if (!scheme) return res.status(404).json({ error: "Scheme not found" });
  if (scheme.status !== "active" && scheme.status !== "pending")
    return res.status(400).json({ error: `This scheme is ${scheme.status}.` });

  if (req.body?.outcome !== "success")
    return res.status(402).json({ error: "Payment failed at the gateway. No instalment was recorded — please retry." });

  const variant = db.schemeVariants.find((v) => v.key === scheme.variant);
  const rate = db.rates.gold["22K"];
  const method = ["card", "upi", "netbanking"].includes(req.body?.method) ? req.body.method : null;
  const first = scheme.instalments.length === 0;
  if (first) {
    // first successful payment activates the scheme and anchors the cycle
    scheme.startedAt = new Date().toISOString();
    scheme.status = "active";
  }
  scheme.instalments.push({
    no: scheme.instalments.length + 1,
    amount: scheme.monthlyAmount,
    paidAt: new Date().toISOString(),
    rate22K: rate,
    grams: Number((scheme.monthlyAmount / rate).toFixed(4)),
    method,
  });
  if (scheme.instalments.length >= variant.tenureMonths) scheme.status = "matured";
  const paid = scheme.instalments[scheme.instalments.length - 1];
  notify(
    scheme.customer.phone,
    "scheme",
    scheme.status === "matured"
      ? `Final instalment received — scheme ${scheme.id} has matured! Visit the Gold Scheme page to redeem your accrued grams. ${variant.bonus}.`
      : first
        ? `Scheme ${scheme.id} is now ACTIVE — first instalment of ₹${paid.amount.toLocaleString("en-IN")} converted to ${paid.grams} g at ₹${paid.rate22K.toLocaleString("en-IN")}/g. Next instalment due ${new Date(schemeView(scheme).nextDueAt).toLocaleDateString("en-IN")}.`
        : `Instalment ${paid.no}/${variant.tenureMonths} of ₹${paid.amount.toLocaleString("en-IN")} received on scheme ${scheme.id} — ${paid.grams} g added at ₹${paid.rate22K.toLocaleString("en-IN")}/g.`
  );
  save();
  res.json(schemeView(scheme));
});

app.post("/api/schemes/:id/redeem", (req, res) => {
  const scheme = db.schemes.find((s) => s.id === req.params.id);
  if (!scheme) return res.status(404).json({ error: "Scheme not found" });
  if (scheme.status !== "matured")
    return res.status(400).json({ error: "Redemption opens once all instalments are paid." });

  const view = schemeView(scheme);
  scheme.status = "redeemed";
  scheme.redemption = {
    code: newId("RDM"),
    at: new Date().toISOString(),
    grams: view.gramsAccrued,
    value: view.currentValue,
    bonus: view.bonus,
  };
  notify(
    scheme.customer.phone,
    "scheme",
    `Redemption code ${scheme.redemption.code} issued for ${view.gramsAccrued} g (₹${view.currentValue.toLocaleString("en-IN")} today). Present it at any showroom or at checkout.`
  );
  save();
  res.json(schemeView(scheme));
});

// Instalment reminders (FR-GSS): checked at boot and every 6 hours. One
// reminder per scheme per due date, remembered on the scheme itself.
function runSchemeReminders() {
  let sent = 0;
  for (const scheme of db.schemes) {
    if (scheme.status !== "active") continue;
    const view = schemeView(scheme);
    if (!view.nextDueAt) continue;
    const due = new Date(view.nextDueAt);
    const daysAway = (due - Date.now()) / 86400000;
    if (daysAway > 3) continue; // remind from 3 days before
    const marker = view.nextDueAt.slice(0, 10);
    if (scheme.lastReminderFor === marker) continue;
    scheme.lastReminderFor = marker;
    sent++;
    notify(
      scheme.customer.phone,
      "scheme",
      daysAway < 0
        ? `Instalment ${view.paidCount + 1}/${view.tenureMonths} of ₹${scheme.monthlyAmount.toLocaleString("en-IN")} on ${view.variantName} (${scheme.id}) is overdue — pay at dpjewellers.example/gold-scheme to keep accruing grams.`
        : `Reminder: instalment ${view.paidCount + 1}/${view.tenureMonths} of ₹${scheme.monthlyAmount.toLocaleString("en-IN")} on ${view.variantName} (${scheme.id}) is due on ${due.toLocaleDateString("en-IN")}.`
    );
  }
  if (sent) save();
}
runSchemeReminders();
setInterval(runSchemeReminders, 6 * 60 * 60 * 1000).unref();

// Scheme ledger for Finance (FR-GSS-08).
app.get("/api/admin/schemes", requireAdmin, (req, res) => {
  const views = db.schemes.map(schemeView);
  res.json({
    totals: {
      enrolments: views.length,
      active: views.filter((v) => v.status === "active").length,
      awaitingFirstPayment: views.filter((v) => v.status === "pending").length,
      collected: views.reduce((a, v) => a + v.totalPaid, 0),
      gramsLiability: Number(views.reduce((a, v) => a + (v.status !== "redeemed" ? v.gramsAccrued : 0), 0).toFixed(3)),
      valueLiability: views.reduce((a, v) => a + (v.status !== "redeemed" ? v.currentValue : 0), 0),
    },
    schemes: db.schemes.map((s) => ({ ...schemeView(s), customer: s.customer })),
  });
});

// ---------------------------------------------------- admin catalogue
app.get("/api/admin/products", requireAdmin, (req, res) => {
  res.json(
    products.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      purity: p.metal.purity,
      netWeight: p.metal.netWeight,
      making: p.making,
      images: p.images,
      price: priceOf(p).total,
      stock: Number.isFinite(p.stock) ? p.stock : null, // null = made-to-order
      featured: Boolean(p.featured),
      published: p.published !== false,
      occasion: p.occasion || [],
    }))
  );
});

// Occasion tags drive the header mega-menu rows and the /shop occasion
// filter — normalise so "Office" and " office " count as one row. The
// vocabulary stays free (a new tag simply becomes a new menu row).
function cleanOccasions(list) {
  if (!Array.isArray(list)) return null;
  const tags = [];
  for (const raw of list) {
    const t = String(raw || "").trim().toLowerCase().slice(0, 24);
    if (t && !tags.includes(t)) tags.push(t);
    if (tags.length === 6) break;
  }
  return tags.length ? tags : null;
}

// Create a single product from the admin form (FR-ADM-03 / FR-CAT).
app.post("/api/admin/products", requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "Give the piece a name." });

  // slug: taken as-is when supplied, otherwise derived from the name
  let slug = String(b.slug || "").trim().toLowerCase();
  if (!slug)
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9-]+$/.test(slug))
    return res.status(400).json({ error: "Slug must be kebab-case (letters, digits, hyphens)." });
  if (products.some((p) => p.slug === slug))
    return res.status(400).json({ error: `"${slug}" already exists — pick another slug.` });

  if (!categories.some((c) => c.key === b.category))
    return res.status(400).json({ error: "Choose a category." });
  const metalType = b.metalType, purity = b.purity;
  if (db.rates[metalType]?.[purity] === undefined)
    return res.status(400).json({ error: `No rate configured for ${metalType} ${purity}.` });

  const gw = Number(b.grossWeight), nw = Number(b.netWeight);
  if (!(gw > 0) || !(nw > 0) || nw > gw)
    return res.status(400).json({ error: "Weights must be positive, with net ≤ gross." });

  const making = b.making || {};
  if (!["perGram", "percent", "flat"].includes(making.basis) || !(Number(making.value) > 0))
    return res.status(400).json({ error: "Set a making charge (per-gram, percent or flat)." });

  const stock = b.stock === undefined || b.stock === "" ? 6 : Number(b.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > 999)
    return res.status(400).json({ error: "Stock must be a whole number between 0 and 999." });

  const sizes = String(b.sizes || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // optional stone — type + carat + rate/carat attach one (cert details optional)
  let stones = [];
  const st = b.stone || {};
  if (st.type || st.caratTotal || st.ratePerCarat) {
    const carat = Number(st.caratTotal), perCarat = Number(st.ratePerCarat);
    if (!st.type || !(carat > 0) || !(perCarat > 0))
      return res.status(400).json({ error: "A stone needs a type, carat > 0 and rate per carat > 0." });
    stones = [{ type: String(st.type), caratTotal: carat, ratePerCarat: perCarat }];
    if (st.certBody) stones[0].certBody = String(st.certBody);
    if (st.certNo) stones[0].certNo = String(st.certNo);
  }

  const hallmarking = b.hallmarkingCharge === undefined || b.hallmarkingCharge === "" ? 45 : Number(b.hallmarkingCharge);
  const certification = b.certificationCharge === undefined || b.certificationCharge === "" ? 0 : Number(b.certificationCharge);
  if (!(hallmarking >= 0) || !(certification >= 0))
    return res.status(400).json({ error: "Hallmarking/certification charges must be numbers ≥ 0." });

  const leadTimeDays = b.leadTimeDays === undefined || b.leadTimeDays === "" ? 0 : Number(b.leadTimeDays);
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 90)
    return res.status(400).json({ error: "Lead time must be a whole number of days, 0–90." });

  const huid = String(b.huid || "").trim().toUpperCase();
  if (huid && !/^[A-Z0-9]{6}$/.test(huid))
    return res.status(400).json({ error: "HUID must be exactly 6 letters/digits (as etched on the piece)." });

  const hsn = String(b.hsn || "").trim();
  if (hsn && !/^\d{4,8}$/.test(hsn))
    return res.status(400).json({ error: "HSN must be 4–8 digits." });

  const product = {
    id: `DPJ-ADM-${String(products.length + 1).padStart(3, "0")}`,
    slug,
    name,
    category: b.category,
    collection: String(b.collection || "").trim() || "Atelier",
    gender: ["women", "men", "unisex"].includes(b.gender) ? b.gender : "women",
    occasion: cleanOccasions(b.occasion) || ["daily"],
    metal: {
      type: metalType,
      purity,
      colour: b.colour || "yellow",
      grossWeight: gw,
      netWeight: nw,
    },
    stones,
    making: { basis: making.basis, value: Number(making.value) },
    otherCharges: certification > 0 ? { hallmarking, certification } : { hallmarking },
    hallmarked: true,
    huid: huid || crypto.randomBytes(3).toString("hex").toUpperCase(),
    hsn: hsn || "7113",
    sizes,
    sizeLabel: sizes.length ? (b.sizeLabel || "Size") : null,
    madeToOrder: !!b.madeToOrder || leadTimeDays > 0,
    leadTimeDays,
    featured: !!b.featured,
    published: b.published !== false,
    engravable: !!b.engravable,
    stock,
    rating: 0,
    reviews: 0,
    images: [b.imageUrl || products[0].images[0], ...(Array.isArray(b.extraImages) ? b.extraImages.filter(Boolean) : [])],
    description:
      String(b.description || "").trim() ||
      `${name} — crafted in ${purity} ${metalType}, hallmarked and priced live on today's rate.`,
  };
  products.push(product);
  audit("catalogue", `${slug} created (${purity} ${metalType}, ${nw} g)`);
  save();
  res.status(201).json({ ok: true, slug, price: priceOf(product).total });
});

app.patch("/api/admin/products/:slug", requireAdmin, (req, res) => {
  const product = products.find((p) => p.slug === req.params.slug);
  if (!product) return res.status(404).json({ error: "Product not found" });
  const body = req.body || {};
  if (typeof body.published === "boolean") product.published = body.published;
  if (typeof body.featured === "boolean") product.featured = body.featured;
  if (body.making) {
    const { basis, value } = body.making;
    if (!["perGram", "percent", "flat"].includes(basis) || !(Number(value) > 0))
      return res.status(400).json({ error: "Invalid making charge" });
    product.making = { basis, value: Number(value) };
  }
  if (body.stock !== undefined) {
    const s = Number(body.stock);
    if (!Number.isInteger(s) || s < 0 || s > 999)
      return res.status(400).json({ error: "Stock must be a whole number between 0 and 999." });
    product.stock = s;
  }
  if (body.images !== undefined) {
    if (!Array.isArray(body.images))
      return res.status(400).json({ error: "images must be a list of URLs." });
    const imgs = body.images.map((s) => String(s || "").trim()).filter(Boolean);
    if (imgs.length < 1 || imgs.length > 8)
      return res.status(400).json({ error: "A piece needs 1 to 8 images — the first one is the cover." });
    for (const u of imgs)
      if (!/^(https?:\/\/|\/)[^\s"']+$/i.test(u) || u.length > 600)
        return res.status(400).json({
          error: `"${u.slice(0, 60)}" is not a valid image URL (https://… or a /path on this site).`,
        });
    product.images = imgs;
  }
  if (body.occasion !== undefined) {
    const occ = cleanOccasions(body.occasion);
    if (!occ)
      return res.status(400).json({
        error: "Give at least one occasion tag — they drive the header menu and shop filters.",
      });
    product.occasion = occ;
  }
  audit("catalogue", `${product.slug}: ${Object.keys(body).join(", ")} updated`);
  save();
  res.json({ ok: true });
});

// CSV bulk upload with validation and per-row error report (FR-CAT-10).
// Workflow: download template.csv (or catalogue.csv for the current SKUs),
// edit in Excel/Sheets, upload back. Existing slugs update, new slugs create.
const CSV_CORE_COLS = ["slug", "name", "category", "metalType", "purity", "colour", "grossWeight", "netWeight", "makingBasis", "makingValue", "imageUrl"];
// Optional columns — include any subset (in any order) after the core ones.
// Empty cells mean "default on create / leave unchanged on update".
const CSV_OPT_COLS = [
  "stock", "sizes", "description", "collection", "gender",
  "stoneType", "stoneCarat", "stoneRatePerCarat", "stoneCertBody", "stoneCertNo",
  "hallmarkingCharge", "certificationCharge", "hsn", "huid",
  "madeToOrder", "leadTimeDays", "engravable", "sizeLabel",
  "featured", "published", "extraImages", "occasion",
];
const CSV_ALL_COLS = CSV_CORE_COLS.concat(CSV_OPT_COLS);

// "1"/"yes"/"true" → true, "0"/"no"/"false" → false, anything else → undefined
function csvBool(v) {
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return undefined;
}

// Quote-aware CSV cell splitter — Excel wraps cells containing commas in
// double quotes and doubles embedded quotes.
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

app.post("/api/admin/products/csv", requireAdmin, (req, res) => {
  const csv = String(req.body?.csv || "").replace(/^﻿/, "").trim();
  if (!csv) return res.status(400).json({ error: "Choose a CSV file (or paste CSV content) first." });

  const rows = csv.split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(rows.shift());
  const missingCols = CSV_CORE_COLS.filter((c) => !header.includes(c));
  const unknownCols = header.filter((h) => !CSV_ALL_COLS.includes(h));
  if (missingCols.length || unknownCols.length)
    return res.status(400).json({
      error:
        (missingCols.length ? `Missing required column(s): ${missingCols.join(", ")}. ` : "") +
        (unknownCols.length ? `Unknown column(s): ${unknownCols.join(", ")}. ` : "") +
        "Optional columns may be omitted entirely — download the template for the full list.",
    });
  const col = {};
  header.forEach((h, i) => { col[h] = i; });

  const report = { created: 0, updated: 0, errors: [] };
  rows.forEach((line, idx) => {
    const rowNo = idx + 2;
    const cells = parseCsvLine(line);
    const get = (name) => (name in col ? (cells[col[name]] ?? "").trim() : "");
    const fail = (msg) => report.errors.push({ row: rowNo, error: msg });

    const slug = get("slug"), name = get("name"), category = get("category");
    const metalType = get("metalType"), purity = get("purity"), colour = get("colour");
    const imageUrl = get("imageUrl");
    if (!/^[a-z0-9-]+$/.test(slug || "")) return fail("slug must be kebab-case");
    if (!name) return fail("name is required");
    if (!categories.some((c) => c.key === category)) return fail(`unknown category "${category}"`);
    if (db.rates[metalType]?.[purity] === undefined) return fail(`no rate for ${metalType} ${purity}`);
    const gw = Number(get("grossWeight")), nw = Number(get("netWeight"));
    if (!(gw > 0) || !(nw > 0) || nw > gw) return fail("weights must be positive and net ≤ gross");
    const makingBasis = get("makingBasis");
    if (!["perGram", "percent", "flat"].includes(makingBasis)) return fail("makingBasis must be perGram|percent|flat");
    if (!(Number(get("makingValue")) > 0)) return fail("makingValue must be positive");

    let stock = null; // null = leave unchanged / default
    if (get("stock") !== "") {
      const s = Number(get("stock"));
      if (!Number.isInteger(s) || s < 0 || s > 999) return fail("stock must be a whole number 0–999");
      stock = s;
    }
    // multi-value cells are ";"-separated (commas belong to the CSV)
    const splitCell = (v) => v.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    const sizes = get("sizes") !== "" ? splitCell(get("sizes")) : null;
    const description = get("description");
    const collection = get("collection");
    const gender = get("gender");
    if (gender && !["women", "men", "unisex"].includes(gender)) return fail("gender must be women|men|unisex");

    // stone: give stoneType + stoneCarat + stoneRatePerCarat to attach one
    let stones = null;
    if (get("stoneType") || get("stoneCarat") || get("stoneRatePerCarat")) {
      const carat = Number(get("stoneCarat")), perCarat = Number(get("stoneRatePerCarat"));
      if (!get("stoneType") || !(carat > 0) || !(perCarat > 0))
        return fail("a stone needs stoneType, stoneCarat > 0 and stoneRatePerCarat > 0");
      stones = [{ type: get("stoneType"), caratTotal: carat, ratePerCarat: perCarat }];
      if (get("stoneCertBody")) stones[0].certBody = get("stoneCertBody");
      if (get("stoneCertNo")) stones[0].certNo = get("stoneCertNo");
    }

    let otherCharges = null;
    if (get("hallmarkingCharge") !== "" || get("certificationCharge") !== "") {
      const hm = get("hallmarkingCharge") === "" ? 45 : Number(get("hallmarkingCharge"));
      const cert = get("certificationCharge") === "" ? 0 : Number(get("certificationCharge"));
      if (!(hm >= 0) || !(cert >= 0)) return fail("hallmarking/certification charges must be numbers ≥ 0");
      otherCharges = cert > 0 ? { hallmarking: hm, certification: cert } : { hallmarking: hm };
    }

    const hsn = get("hsn");
    if (hsn && !/^\d{4,8}$/.test(hsn)) return fail("hsn must be 4–8 digits");
    const huid = get("huid").toUpperCase();
    if (huid && !/^[A-Z0-9]{6}$/.test(huid)) return fail("huid must be 6 letters/digits");

    const flags = {};
    for (const key of ["madeToOrder", "engravable", "featured", "published"]) {
      flags[key] = get(key) === "" ? null : csvBool(get(key));
      if (flags[key] === undefined) return fail(`${key} must be 1 or 0`);
    }
    let leadTimeDays = null;
    if (get("leadTimeDays") !== "") {
      const d = Number(get("leadTimeDays"));
      if (!Number.isInteger(d) || d < 0 || d > 90) return fail("leadTimeDays must be a whole number 0–90");
      leadTimeDays = d;
    }
    const sizeLabel = get("sizeLabel");
    const extraImages = get("extraImages") !== "" ? splitCell(get("extraImages")) : null;
    const occasion = get("occasion") !== "" ? cleanOccasions(splitCell(get("occasion"))) : null;

    const base = {
      name, category,
      metal: { type: metalType, purity, colour: colour || "yellow", grossWeight: gw, netWeight: nw },
      making: { basis: makingBasis, value: Number(get("makingValue")) },
    };
    const existing = products.find((p) => p.slug === slug);
    if (existing) {
      Object.assign(existing, base);
      if (imageUrl || extraImages)
        existing.images = [imageUrl || existing.images[0], ...(extraImages || existing.images.slice(1))];
      if (stock !== null) existing.stock = stock;
      if (sizes) {
        existing.sizes = sizes;
        existing.sizeLabel = sizeLabel || existing.sizeLabel || "Size";
      } else if (sizeLabel) existing.sizeLabel = sizeLabel;
      if (description) existing.description = description;
      if (collection) existing.collection = collection;
      if (gender) existing.gender = gender;
      if (stones) existing.stones = stones;
      if (otherCharges) existing.otherCharges = otherCharges;
      if (hsn) existing.hsn = hsn;
      if (huid) existing.huid = huid;
      if (flags.madeToOrder !== null) existing.madeToOrder = flags.madeToOrder;
      if (leadTimeDays !== null) existing.leadTimeDays = leadTimeDays;
      if (flags.engravable !== null) existing.engravable = flags.engravable;
      if (flags.featured !== null) existing.featured = flags.featured;
      if (flags.published !== null) existing.published = flags.published;
      if (occasion) existing.occasion = occasion;
      report.updated++;
    } else {
      products.push({
        id: `DPJ-CSV-${String(products.length + 1).padStart(3, "0")}`,
        slug,
        ...base,
        collection: collection || "Imported",
        gender: gender || "women",
        occasion: occasion || ["daily"],
        stones: stones || [],
        otherCharges: otherCharges || { hallmarking: 45 },
        hallmarked: true,
        huid: huid || crypto.randomBytes(3).toString("hex").toUpperCase(),
        hsn: hsn || "7113",
        sizes: sizes || [],
        sizeLabel: sizes && sizes.length ? (sizeLabel || "Size") : null,
        madeToOrder: flags.madeToOrder === null ? (leadTimeDays || 0) > 0 : flags.madeToOrder,
        leadTimeDays: leadTimeDays === null ? 0 : leadTimeDays,
        featured: flags.featured === null ? false : flags.featured,
        published: flags.published === null ? true : flags.published,
        engravable: flags.engravable === null ? false : flags.engravable,
        stock: stock === null ? 6 : stock,
        rating: 0,
        reviews: 0,
        images: [imageUrl || products[0].images[0], ...(extraImages || [])],
        description: description || `${name} — crafted in ${purity} ${metalType}. Full specifications to follow.`,
      });
      report.created++;
    }
  });
  audit("catalogue-csv", `created ${report.created}, updated ${report.updated}, errors ${report.errors.length}`);
  save();
  res.json(report);
});

// Blank template with worked examples — the starting point for new SKUs.
app.get("/api/admin/export/template.csv", (req, res) => {
  if (!exportAuthed(req, res, "catalogue")) return;
  sendCsv(res, "dpj-catalogue-template.csv", CSV_ALL_COLS, [
    // plain gold band — only the everyday fields filled in
    ["kaveri-gold-band", "Kaveri Gold Band", "rings", "gold", "22K", "yellow", 4.4, 4.2, "perGram", 760, "",
      6, "10;12;14", "Slim daily-wear band in bright 22K.", "Heritage", "women",
      "", "", "", "", "", 45, "", "7113", "", 0, 0, 1, "Ring size", 0, 1, "", "daily;office"],
    // certified diamond piece — every column in use, incl. stone & made-to-order
    ["ira-diamond-pendant", "Ira Diamond Pendant", "necklaces", "gold", "18K", "rose", 3.2, 2.9, "percent", 14, "",
      4, "", "Rose-gold pendant crowned with a certified solitaire.", "Éclat Bridal", "women",
      "diamond", 0.25, 180000, "IGI", "IGI-2026-118", 45, 750, "7113", "", 1, 21, 0, "", 1, 1, "", "wedding;gifting"],
  ]);
});

// Current catalogue in the SAME columns — edit in Excel, upload to update.
app.get("/api/admin/export/catalogue.csv", (req, res) => {
  if (!exportAuthed(req, res, "catalogue")) return;
  sendCsv(
    res,
    "dpj-catalogue.csv",
    CSV_ALL_COLS,
    products.map((p) => {
      const s = (p.stones || [])[0] || {};
      return [
        p.slug,
        p.name,
        p.category,
        p.metal.type,
        p.metal.purity,
        p.metal.colour,
        p.metal.grossWeight,
        p.metal.netWeight,
        p.making.basis,
        p.making.value,
        p.images[0],
        Number.isFinite(p.stock) ? p.stock : "",
        (p.sizes || []).join(";"),
        p.description || "",
        p.collection || "",
        p.gender || "",
        s.type || "",
        s.caratTotal ?? "",
        s.ratePerCarat ?? "",
        s.certBody || "",
        s.certNo || "",
        p.otherCharges?.hallmarking ?? "",
        p.otherCharges?.certification ?? "",
        p.hsn || "",
        p.huid || "",
        p.madeToOrder ? 1 : 0,
        p.leadTimeDays ?? 0,
        p.engravable ? 1 : 0,
        p.sizeLabel || "",
        p.featured ? 1 : 0,
        p.published ? 1 : 0,
        (p.images || []).slice(1).join(";"),
        (p.occasion || []).join(";"),
      ];
    })
  );
});

// ---------------------------------------------------- customer accounts
// BRD 7.5 — mobile-OTP login (FR-ACC-01), profile & addresses (FR-ACC-03/04),
// unified history (FR-ACC-05), and DPDP data export / account deletion
// (FR-ACC-11). OTPs are simulated: the code is returned in the response so
// the demo needs no SMS provider — a live SMS gateway replaces only that.
if (!db.customers) db.customers = [];
if (!db.otps) db.otps = {};
if (!db.sessions) db.sessions = {};
if (!db.abandoned) db.abandoned = {};

function customerByPhone(phone) {
  return db.customers.find((c) => c.phone === phone);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OTP_RESEND_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;

function authedCustomer(req) {
  const token = req.headers["x-auth-token"] || "";
  const entry = db.sessions[token];
  if (!entry) return null;
  // legacy sessions were stored as a bare phone string
  const phone = typeof entry === "string" ? entry : entry.phone;
  const createdAt = typeof entry === "string" ? null : entry.createdAt;
  if (createdAt && Date.now() - new Date(createdAt).getTime() > SESSION_TTL_MS) {
    delete db.sessions[token];
    save();
    return null;
  }
  return phone ? customerByPhone(phone) : null;
}

app.post("/api/auth/otp", (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  // resend throttle — one code per number per 30 s (anti-abuse)
  const existing = db.otps[phone];
  if (existing?.sentAt && Date.now() - existing.sentAt < OTP_RESEND_SECONDS * 1000) {
    const wait = Math.ceil((OTP_RESEND_SECONDS * 1000 - (Date.now() - existing.sentAt)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.otps[phone] = { code, expiresAt: Date.now() + 5 * 60 * 1000, sentAt: Date.now(), attempts: 0 };
  notify(phone, "otp", `Your DP Jewellers sign-in code is ${code}. It is valid for 5 minutes. Never share it with anyone.`, ["sms"]);
  save();
  res.json({ sent: true, demoOtp: code, note: "Demo mode — in production this arrives by SMS/WhatsApp." });
});

app.post("/api/auth/verify", (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const entry = db.otps[phone];
  if (!entry || entry.expiresAt < Date.now())
    return res.status(400).json({ error: "OTP expired — request a fresh one." });
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts > OTP_MAX_ATTEMPTS) {
    delete db.otps[phone]; // brute-force guard: burn the code
    save();
    return res.status(429).json({ error: "Too many attempts — request a fresh OTP." });
  }
  if (entry.code !== otp) {
    save();
    return res.status(400).json({ error: "That OTP doesn't match." });
  }
  delete db.otps[phone];

  let customer = customerByPhone(phone);
  if (!customer) {
    customer = {
      phone,
      name: null,
      email: null,
      dob: null,
      anniversary: null,
      ringSize: null,
      addresses: [],
      createdAt: new Date().toISOString(),
    };
    db.customers.push(customer);
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = { phone, createdAt: new Date().toISOString() };
  save();
  res.json({ token, customer });
});

app.post("/api/auth/logout", (req, res) => {
  delete db.sessions[req.headers["x-auth-token"] || ""];
  save();
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  const phone = customer.phone;
  res.json({
    customer,
    orders: db.orders
      .filter((o) => o.customer.phone === phone)
      .map((o) => ({
        orderId: o.orderId,
        placedAt: o.placedAt,
        status: o.status,
        payable: o.payable ?? o.total,
        items: o.lines.map((l) => `${l.name}${l.size ? ` (${l.size})` : ""} × ${l.qty}`).join(", "),
        invoiceAvailable: invoiceEligible(o),
      }))
      .reverse(),
    schemes: db.schemes.filter((s) => s.customer.phone === phone).map(schemeView),
    appointments: [...db.appointments.filter((a) => a.phone === phone)].reverse(),
    enquiries: [...db.enquiries.filter((e) => e.phone === phone)].reverse(),
    buybacks: [...db.buybacks.filter((b) => b.phone === phone)].reverse(),
    returns: [...db.returns.filter((r) => r.phone === phone)].reverse(),
  });
});

app.patch("/api/me", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  for (const key of ["name", "email", "dob", "anniversary", "ringSize", "gender"]) {
    if (key in (req.body || {})) customer[key] = req.body[key] || null;
  }
  save();
  res.json(customer);
});

app.post("/api/me/addresses", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  const { label, line, pincode, city, isDefault } = req.body || {};
  if (!line || !/^[1-9]\d{5}$/.test(String(pincode || "")))
    return res.status(400).json({ error: "Address line and a valid PIN code are required." });
  const address = {
    id: crypto.randomBytes(4).toString("hex"),
    label: label || "Home",
    line,
    pincode: String(pincode),
    city: city || null,
    isDefault: Boolean(isDefault) || customer.addresses.length === 0,
  };
  if (address.isDefault) customer.addresses.forEach((a) => (a.isDefault = false));
  customer.addresses.push(address);
  save();
  res.status(201).json(customer.addresses);
});

app.delete("/api/me/addresses/:id", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  customer.addresses = customer.addresses.filter((a) => a.id !== req.params.id);
  if (customer.addresses.length && !customer.addresses.some((a) => a.isDefault))
    customer.addresses[0].isDefault = true;
  save();
  res.json(customer.addresses);
});

// DPDP data export — everything we hold against this mobile number.
app.get("/api/me/export", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  const phone = customer.phone;
  const dump = {
    exportedAt: new Date().toISOString(),
    profile: customer,
    orders: db.orders.filter((o) => o.customer.phone === phone),
    schemes: db.schemes.filter((s) => s.customer.phone === phone),
    appointments: db.appointments.filter((a) => a.phone === phone),
    enquiries: db.enquiries.filter((e) => e.phone === phone),
    buybacks: db.buybacks.filter((b) => b.phone === phone),
    returns: db.returns.filter((r) => r.phone === phone),
    newsletter: db.newsletter.includes(customer.email) ? [customer.email] : [],
  };
  res.setHeader("Content-Disposition", 'attachment; filename="dpj-my-data.json"');
  res.json(dump);
});

// DPDP erasure — removes the profile and sessions. Order/tax records are
// retained as statute requires, noted in the response.
app.delete("/api/me", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  db.customers = db.customers.filter((c) => c.phone !== customer.phone);
  for (const [token, entry] of Object.entries(db.sessions)) {
    const phone = typeof entry === "string" ? entry : entry.phone;
    if (phone === customer.phone) delete db.sessions[token];
  }
  save();
  res.json({
    ok: true,
    message:
      "Your profile and sign-in are deleted. Order and invoice records are retained for the statutory period as required by GST and PMLA rules.",
  });
});

// ---------------------------------------------------- abandoned carts
// FR-CHK-10 — capture a contactable snapshot when checkout stalls; cleared
// automatically when an order for that phone completes.
app.post("/api/carts/abandon", (req, res) => {
  const { phone, name, items, value } = req.body || {};
  if (!/^[6-9]\d{9}$/.test(String(phone || ""))) return res.json({ ok: false });
  if (!Array.isArray(items) || items.length === 0) return res.json({ ok: false });
  db.abandoned[String(phone)] = {
    phone: String(phone),
    name: name || null,
    items: items.slice(0, 10),
    value: Number(value) || 0,
    at: new Date().toISOString(),
  };
  save();
  res.json({ ok: true });
});

app.get("/api/admin/abandoned", requireAdmin, (req, res) => {
  res.json(
    Object.values(db.abandoned).sort((a, b) => b.at.localeCompare(a.at))
  );
});

// ---------------------------------------------------- DPJ Rewards (loyalty)
// BRD phase-3 growth. Points accrue when an order is DELIVERED (not placed,
// so cancellations can't farm points), at a tier-multiplied rate; they spend
// like rupees at checkout up to a capped share of the bag. Referral codes
// give the friend a flat first-order discount and the referrer bonus points
// once that first order is delivered.
const LOYALTY = {
  earnPer100: 2,             // base points per ₹100 of payable
  redeemValue: 1,            // ₹ per point at checkout
  redeemCapPct: 25,          // points may cover at most this % of the bag
  referralFlatOff: 500,      // friend's first-order discount
  referralMinTotal: 10000,   // friend's bag must be at least this
  referralBonusPoints: 500,  // referrer's reward on first delivered order
  tiers: [
    { key: "silver", name: "Silver", min: 0, multiplier: 1 },
    { key: "gold", name: "Gold", min: 50000, multiplier: 1.5 },
    { key: "platinum", name: "Platinum", min: 150000, multiplier: 2 },
  ],
};

if (!db.loyalty || typeof db.loyalty !== "object") db.loyalty = {};
if (!Array.isArray(db.referrals)) db.referrals = [];

function loyaltyAccount(phone) {
  if (!db.loyalty[phone]) {
    db.loyalty[phone] = {
      phone,
      points: 0,
      lifetimeSpend: 0,
      referralCode: "DPJ" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      ledger: [],
    };
  }
  return db.loyalty[phone];
}

function tierOf(acc) {
  return LOYALTY.tiers.filter((t) => acc.lifetimeSpend >= t.min).pop();
}

function loyaltyView(acc) {
  const tier = tierOf(acc);
  const next = LOYALTY.tiers.find((t) => t.min > acc.lifetimeSpend);
  return {
    points: acc.points,
    lifetimeSpend: acc.lifetimeSpend,
    referralCode: acc.referralCode,
    tier: { name: tier.name, multiplier: tier.multiplier },
    nextTier: next ? { name: next.name, spendAway: next.min - acc.lifetimeSpend } : null,
    referralsEarned: db.referrals.filter((r) => r.referrerPhone === acc.phone && r.status === "Earned").length,
    ledger: [...acc.ledger].slice(-20).reverse(),
  };
}

app.get("/api/loyalty/meta", (req, res) => res.json(LOYALTY));

app.get("/api/loyalty/me", (req, res) => {
  const customer = authedCustomer(req);
  if (!customer) return res.status(401).json({ error: "Please sign in." });
  const acc = loyaltyAccount(customer.phone);
  save();
  res.json(loyaltyView(acc));
});

// ---------------------------------------------------- custom design enquiries
// BRD 7.11 — enquiry → internal quotation with validity → customer accepts
// and pays an advance → production. Advance is a config percentage of the
// quote; payment is the same simulated gateway shape as checkout.
const ENQUIRY_ADVANCE_PCT = 25;
const BUDGET_BANDS = [
  "Under ₹50,000",
  "₹50,000 – ₹1,00,000",
  "₹1,00,000 – ₹2,50,000",
  "Above ₹2,50,000",
];

if (!Array.isArray(db.enquiries)) db.enquiries = [];

app.get("/api/enquiries/meta", (req, res) =>
  res.json({ budgetBands: BUDGET_BANDS, advancePct: ENQUIRY_ADVANCE_PCT })
);

app.post("/api/enquiries", (req, res) => {
  const { name, phone, email, category, budgetBand, metal, purity, stone, occasionDate, description, referenceUrl } = req.body || {};
  if (!name || !/^[6-9]\d{9}$/.test(String(phone || "")))
    return res.status(400).json({ error: "Enter your name and a valid 10-digit mobile number." });
  if (!BUDGET_BANDS.includes(budgetBand))
    return res.status(400).json({ error: "Pick a budget band." });
  if (!description || description.trim().length < 10)
    return res.status(400).json({ error: "Describe the piece you have in mind (a sentence or two)." });

  const enquiry = {
    id: newId("ENQ"),
    name,
    phone: String(phone),
    email: email || null,
    category: category || "other",
    budgetBand,
    metal: metal || "gold",
    purity: purity || "22K",
    stone: stone || null,
    occasionDate: occasionDate || null,
    description: description.trim(),
    referenceUrl: referenceUrl || null,
    status: "New",
    quote: null,
    advance: null,
    history: [{ status: "New", at: new Date().toISOString() }],
  };
  db.enquiries.push(enquiry);
  save();
  res.status(201).json(enquiry);
});

app.get("/api/enquiries/my", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter the 10-digit mobile used on the enquiry." });
  res.json([...db.enquiries.filter((e) => e.phone === phone)].reverse());
});

// Customer accepts a valid quotation → advance becomes payable.
app.post("/api/enquiries/:id/accept", (req, res) => {
  const enquiry = db.enquiries.find((e) => e.id === req.params.id);
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  if (enquiry.phone !== String(req.body?.phone || "").trim())
    return res.status(403).json({ error: "Mobile number does not match this enquiry." });
  if (enquiry.status !== "Quoted")
    return res.status(400).json({ error: `This enquiry is ${enquiry.status.toLowerCase()}, not awaiting acceptance.` });
  if (new Date(enquiry.quote.validUntil) < new Date())
    return res.status(400).json({ error: "This quotation has expired — ask us to re-quote." });

  enquiry.status = "Advance Pending";
  enquiry.history.push({ status: "Advance Pending", at: new Date().toISOString() });
  save();
  res.json(enquiry);
});

app.post("/api/enquiries/:id/advance", (req, res) => {
  const enquiry = db.enquiries.find((e) => e.id === req.params.id);
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  if (enquiry.status !== "Advance Pending")
    return res.status(400).json({ error: "No advance is due on this enquiry." });
  if (req.body?.outcome !== "success")
    return res.status(402).json({ error: "Payment failed at the gateway — please retry." });

  enquiry.advance = {
    amount: Math.round((enquiry.quote.amount * ENQUIRY_ADVANCE_PCT) / 100),
    paidAt: new Date().toISOString(),
  };
  enquiry.status = "In Production";
  enquiry.history.push({ status: "In Production", at: new Date().toISOString(), note: "Advance received" });
  notify(
    enquiry.phone,
    "commission",
    `Advance of ₹${enquiry.advance.amount.toLocaleString("en-IN")} received for commission ${enquiry.id} — your piece is now in production. We'll share updates as the karigars work.`
  );
  save();
  res.json(enquiry);
});

app.get("/api/admin/enquiries", requireAdmin, (req, res) => {
  res.json({ advancePct: ENQUIRY_ADVANCE_PCT, enquiries: [...db.enquiries].reverse() });
});

app.patch("/api/admin/enquiries/:id", requireAdmin, (req, res) => {
  const enquiry = db.enquiries.find((e) => e.id === req.params.id);
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  const { action } = req.body || {};

  if (action === "quote") {
    if (!["New", "Quoted"].includes(enquiry.status))
      return res.status(400).json({ error: `Cannot quote an enquiry that is ${enquiry.status}.` });
    const amount = Number(req.body.amount);
    const validityDays = Number(req.body.validityDays) || 7;
    if (!(amount > 0)) return res.status(400).json({ error: "Enter a quote amount." });
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);
    enquiry.quote = {
      amount: Math.round(amount),
      validUntil: validUntil.toISOString(),
      note: req.body.note || null,
      quotedAt: new Date().toISOString(),
    };
    enquiry.status = "Quoted";
    enquiry.history.push({ status: "Quoted", at: new Date().toISOString(), note: `₹${Math.round(amount).toLocaleString("en-IN")}` });
    notify(
      enquiry.phone,
      "commission",
      `Your quotation for commission ${enquiry.id} is ready: ₹${enquiry.quote.amount.toLocaleString("en-IN")}, valid until ${new Date(enquiry.quote.validUntil).toLocaleDateString("en-IN")}. Review and accept at dpjewellers.example/custom.`
    );
  } else if (action === "decline") {
    if (!["New", "Quoted"].includes(enquiry.status))
      return res.status(400).json({ error: "Only new or quoted enquiries can be declined." });
    enquiry.status = "Declined";
    enquiry.history.push({ status: "Declined", at: new Date().toISOString(), note: req.body.note || null });
  } else if (action === "ready") {
    if (enquiry.status !== "In Production")
      return res.status(400).json({ error: "Only in-production pieces can be marked ready." });
    enquiry.status = "Ready";
    enquiry.history.push({ status: "Ready", at: new Date().toISOString() });
    notify(enquiry.phone, "commission", `Your commissioned piece (${enquiry.id}) is ready! Visit us to collect it, or we'll arrange insured delivery — the balance is payable at handover.`);
  } else if (action === "complete") {
    if (enquiry.status !== "Ready")
      return res.status(400).json({ error: "Only ready pieces can be completed." });
    enquiry.status = "Completed";
    enquiry.history.push({ status: "Completed", at: new Date().toISOString() });
  } else {
    return res.status(400).json({ error: "Unknown action" });
  }
  audit("enquiry", `${enquiry.id}: ${action}`);
  save();
  res.json({ ok: true, enquiry });
});

// ---------------------------------------------------- CSV exports (FR-RPT-10)
// Browser downloads can't set headers, so these two accept ?key=.
function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, header, rows) {
  const body = [header.join(",")]
    .concat(rows.map((r) => r.map(csvEscape).join(",")))
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + body);
}

app.get("/api/admin/export/orders.csv", (req, res) => {
  if (!exportAuthed(req, res, "orders")) return;
  const rows = [...db.orders].reverse().map((o) => [
    o.orderId,
    o.placedAt,
    o.status,
    o.customer.name,
    o.customer.phone,
    o.customer.email || "",
    o.customer.pincode || "",
    o.lines.map((l) => `${l.name}${l.size ? ` (${l.size})` : ""} x${l.qty}`).join("; "),
    o.payment.mode,
    o.payment.status,
    o.total,
    o.discount || 0,
    o.coupon || "",
    o.payable ?? o.total,
  ]);
  // summary block for the shop's day-book
  const live = db.orders.filter((o) => !["Cancelled", "Refunded"].includes(o.status));
  rows.push([], ["Total orders", db.orders.length], ["Open + fulfilled revenue", live.reduce((s, o) => s + (o.payable ?? o.total), 0)]);
  sendCsv(
    res,
    `dpj-orders-${new Date().toISOString().slice(0, 10)}.csv`,
    ["orderId", "placedAt", "status", "customer", "phone", "email", "pincode", "items", "paymentMode", "paymentStatus", "gross", "discount", "coupon", "payable"],
    rows
  );
});

// Rate-history report — honours the console's metal and window filters.
app.get("/api/admin/export/rates.csv", (req, res) => {
  if (!exportAuthed(req, res, "rates")) return;
  const { metal, days } = req.query;
  let rows = [...db.rateAudit];
  if (metal) rows = rows.filter((h) => h.metal === metal);
  const nDays = Number(days);
  if (Number.isFinite(nDays) && nDays > 0)
    rows = rows.filter((h) => Date.parse(h.at) >= Date.now() - nDays * 864e5);
  const out = rows.reverse().map((h) => [
    h.at,
    h.metal,
    h.purity,
    h.from,
    h.to,
    `${h.to >= h.from ? "+" : "-"}${(Math.abs((h.to - h.from) / h.from) * 100).toFixed(2)}%`,
    h.maker,
    h.checker,
  ]);
  out.push([], ["Changes in report", rows.length], ["Window", Number.isFinite(nDays) && nDays > 0 ? `last ${nDays} days` : "full history"], ["Metal", metal || "all"], []);
  out.push(["Current live rates (₹/g)"]);
  for (const [m, table] of Object.entries(db.rates))
    for (const [p, v] of Object.entries(table)) out.push([`${m} ${p}`, v]);
  sendCsv(
    res,
    `dpj-rate-history-${new Date().toISOString().slice(0, 10)}.csv`,
    ["publishedAt", "metal", "purity", "from", "to", "move", "maker", "checker"],
    out
  );
});

app.get("/api/admin/export/customers.csv", (req, res) => {
  if (!exportAuthed(req, res, "customers")) return;
  const dir = customerDirectory();
  const rows = dir.map((r) => [
    r.name || "",
    r.phone,
    r.email || "",
    r.registered ? "account" : "guest",
    r.since || "",
    r.orders,
    r.spend,
    r.points,
    r.tier,
    r.lastOrderAt || "",
  ]);
  const revenue = dir.reduce((s, r) => s + r.spend, 0);
  rows.push([], ["Total customers", dir.length], ["Registered accounts", dir.filter((r) => r.registered).length], ["Lifetime revenue", revenue]);
  sendCsv(
    res,
    `dpj-customers-${new Date().toISOString().slice(0, 10)}.csv`,
    ["name", "phone", "email", "type", "memberSince", "orders", "lifetimeValue", "points", "tier", "lastOrderAt"],
    rows
  );
});

app.get("/api/admin/export/schemes.csv", (req, res) => {
  if (!exportAuthed(req, res, "schemes")) return;
  sendCsv(
    res,
    "dpj-schemes.csv",
    ["schemeId", "variant", "customer", "phone", "monthly", "startedAt", "status", "instalmentsPaid", "totalPaid", "gramsAccrued"],
    db.schemes.map((s) => {
      const grams = s.instalments.reduce((a, i) => a + i.grams, 0);
      return [
        s.id,
        s.variant,
        s.customer.name,
        s.customer.phone,
        s.monthlyAmount,
        s.startedAt,
        s.status,
        s.instalments.length,
        s.instalments.reduce((a, i) => a + i.amount, 0),
        grams.toFixed(3),
      ];
    })
  );
});

// ---------------------------------------------------- SEO (BRD 8.6)
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /api/", `Sitemap: ${req.protocol}://${req.get("host")}/sitemap.xml`].join("\n")
  );
});

app.get("/sitemap.xml", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const staticPaths = ["/", "/shop", "/gold-scheme", "/appointments", "/old-gold", "/custom", "/track"];
  const urls = staticPaths
    .concat(published().map((p) => `/product/${p.slug}`))
    .map((path) => `  <url><loc>${base}${path}</loc></url>`)
    .join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

// ---------------------------------------------------- coupons
app.post("/api/coupons/validate", (req, res) => {
  try {
    const { code, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "Your bag is empty." });
    const lines = [];
    for (const item of items) {
      const product = published().find((p) => p.slug === item.slug);
      if (!product) return res.status(400).json({ error: `Unknown item: ${item.slug}` });
      const qty = Math.max(1, Math.min(5, Number(item.qty) || 1));
      lines.push({ slug: product.slug, qty, lineTotal: priceOf(product).total * qty });
    }
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    const { coupon, discount } = applyCoupon(code, lines, total);
    res.json({
      code: coupon.code,
      description: coupon.description || null,
      discount,
      total,
      payable: total - discount,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/admin/coupons", requireAdmin, (req, res) => {
  res.json([...db.coupons].reverse());
});

app.post("/api/admin/coupons", requireAdmin, (req, res) => {
  const { code, type, value, minTotal, maxDiscount, expiresAt, maxUses, description } = req.body || {};
  const clean = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(clean))
    return res.status(400).json({ error: "Code must be 3–20 letters/digits." });
  if (db.coupons.some((c) => c.code === clean))
    return res.status(400).json({ error: `Code ${clean} already exists.` });
  if (!["percent", "flat", "makingWaiver"].includes(type))
    return res.status(400).json({ error: "Unknown coupon type." });
  const v = Number(value);
  if (!(v > 0) || ((type === "percent" || type === "makingWaiver") && v > 100))
    return res.status(400).json({ error: "Enter a valid value." });

  const coupon = {
    code: clean,
    type,
    value: v,
    minTotal: Number(minTotal) > 0 ? Number(minTotal) : null,
    maxDiscount: Number(maxDiscount) > 0 ? Number(maxDiscount) : null,
    expiresAt: expiresAt || null,
    maxUses: Number(maxUses) > 0 ? Number(maxUses) : null,
    uses: 0,
    active: true,
    createdAt: new Date().toISOString(),
    description: description || null,
  };
  db.coupons.push(coupon);
  audit("coupon", `${coupon.code} created (${coupon.type} ${coupon.value})`);
  save();
  res.status(201).json(coupon);
});

app.patch("/api/admin/coupons/:code", requireAdmin, (req, res) => {
  const coupon = db.coupons.find((c) => c.code === req.params.code.toUpperCase());
  if (!coupon) return res.status(404).json({ error: "Coupon not found" });
  if (typeof req.body?.active === "boolean") coupon.active = req.body.active;
  audit("coupon", `${coupon.code} ${coupon.active ? "enabled" : "disabled"}`);
  save();
  res.json(coupon);
});

// ---------------------------------------------------- old-gold buyback
// BRD FR-RET-06/07 — indicative valuation online from the live rate with
// deductions shown transparently; final valuation happens at assay.
const BUYBACK_POLICY = {
  assayDeductionPctHallmarked: 2,
  assayDeductionPctUnmarked: 6,
  cashPayoutExtraPct: 2, // exchange credit is favoured over cash
};

if (!Array.isArray(db.buybacks)) db.buybacks = [];

function buybackIndicative({ metalType, purity, weight, hallmarked, payout }) {
  const rate = db.rates[metalType]?.[purity];
  if (rate === undefined) return null;
  const grossValue = weight * rate;
  const deductions = [];
  const assayPct = hallmarked
    ? BUYBACK_POLICY.assayDeductionPctHallmarked
    : BUYBACK_POLICY.assayDeductionPctUnmarked;
  deductions.push({
    label: `Melting & assay (${assayPct}%${hallmarked ? ", hallmarked" : ", non-hallmarked"})`,
    amount: Math.round((grossValue * assayPct) / 100),
  });
  if (payout === "cash") {
    deductions.push({
      label: `Cash payout (${BUYBACK_POLICY.cashPayoutExtraPct}%) — exchange credit waives this`,
      amount: Math.round((grossValue * BUYBACK_POLICY.cashPayoutExtraPct) / 100),
    });
  }
  const net = Math.round(grossValue - deductions.reduce((a, d) => a + d.amount, 0));
  return { ratePerGram: rate, grossValue: Math.round(grossValue), deductions, net };
}

app.post("/api/buyback", (req, res) => {
  const { name, phone, metalType, purity, weight, hallmarked, hasInvoice, payout, notes } = req.body || {};
  if (!name || !/^[6-9]\d{9}$/.test(String(phone || "")))
    return res.status(400).json({ error: "Enter your name and a valid 10-digit mobile number." });
  const w = Number(weight);
  if (!(w > 0) || w > 2000)
    return res.status(400).json({ error: "Enter the item weight in grams." });
  if (!["exchange", "cash"].includes(payout))
    return res.status(400).json({ error: "Choose exchange credit or cash payout." });
  const indicative = buybackIndicative({
    metalType, purity, weight: w, hallmarked: Boolean(hallmarked), payout,
  });
  if (!indicative) return res.status(400).json({ error: "Unknown metal or purity." });

  const request = {
    id: newId("BBK"),
    name,
    phone: String(phone),
    metalType,
    purity,
    weight: w,
    hallmarked: Boolean(hallmarked),
    hasInvoice: Boolean(hasInvoice),
    payout,
    notes: notes || null,
    indicative,
    finalValue: null,
    status: "Requested",
    history: [{ status: "Requested", at: new Date().toISOString() }],
  };
  db.buybacks.push(request);
  notify(
    request.phone,
    "buyback",
    `Old-gold request ${request.id} registered — indicative value ₹${indicative.net.toLocaleString("en-IN")}. Bring the item to any showroom; final value is set at assay in front of you.`
  );
  save();
  res.status(201).json(request);
});

app.get("/api/buyback/my", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter the 10-digit mobile used on the request." });
  res.json([...db.buybacks.filter((b) => b.phone === phone)].reverse());
});

app.get("/api/admin/buyback", requireAdmin, (req, res) => {
  res.json({ policy: BUYBACK_POLICY, buybacks: [...db.buybacks].reverse() });
});

app.patch("/api/admin/buyback/:id", requireAdmin, (req, res) => {
  const request = db.buybacks.find((b) => b.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  const to = req.body?.status;
  const allowed = {
    Requested: ["Item Received", "Cancelled"],
    "Item Received": ["Assayed", "Cancelled"],
    Assayed: ["Settled"],
  };
  if (!(allowed[request.status] || []).includes(to))
    return res.status(400).json({ error: `Cannot move from "${request.status}" to "${to}"` });
  if (to === "Assayed") {
    const v = Number(req.body?.finalValue);
    if (!(v > 0)) return res.status(400).json({ error: "Enter the assayed final value." });
    request.finalValue = Math.round(v);
  }
  request.status = to;
  request.history.push({ status: to, at: new Date().toISOString(), note: req.body?.note || null });
  audit("buyback", `${request.id}: → ${to}${request.finalValue ? ` (₹${request.finalValue})` : ""}`);
  const BUYBACK_MESSAGES = {
    "Item Received": `We've received your item for old-gold request ${request.id}. Assay happens next — you're welcome to watch.`,
    Assayed: `Assay complete for request ${request.id}: final value ₹${(request.finalValue || 0).toLocaleString("en-IN")} (${request.payout === "cash" ? "cash payout" : "exchange credit"}).`,
    Settled: `Old-gold request ${request.id} is settled. Thank you for trusting us with your gold.`,
    Cancelled: `Old-gold request ${request.id} has been cancelled.`,
  };
  if (BUYBACK_MESSAGES[to]) notify(request.phone, "buyback", BUYBACK_MESSAGES[to]);
  save();
  res.json({ ok: true, request });
});

// ---------------------------------------------------- returns & exchange
// BRD 7.9. Requests are allowed only on delivered orders, inside the
// return window, and never for made-to-order pieces (FR-RET-02). Refund
// release sits behind a warehouse QC gate (FR-RET-04).
const RETURN_FLOW = [
  "Requested",
  "Pickup Scheduled",
  "Received at Warehouse",
  "QC Passed",
  "Refund Initiated",
  "Refunded",
];
const RETURN_TERMINAL = ["QC Failed", "Cancelled"];

if (!Array.isArray(db.returns)) db.returns = [];

app.post("/api/returns", (req, res) => {
  const { orderId, phone, slug, size, type, reason, comments } = req.body || {};
  const order = db.orders.find(
    (o) =>
      o.orderId.toUpperCase() === String(orderId || "").trim().toUpperCase() &&
      o.customer.phone === String(phone || "").trim()
  );
  if (!order) return res.status(404).json({ error: "No order found for that ID and mobile number." });
  if (config.returnWindowDays === 0)
    return res.status(400).json({ error: "Returns are currently not accepted per store policy." });
  if (order.status !== "Delivered")
    return res.status(400).json({ error: "Returns open once the order is delivered." });

  const deliveredAt = order.statusTimeline.find((t) => t.status === "Delivered")?.at;
  const ageDays = (Date.now() - new Date(deliveredAt).getTime()) / 86400000;
  if (ageDays > config.returnWindowDays)
    return res.status(400).json({ error: `The ${config.returnWindowDays}-day return window for this order has closed.` });

  const line = order.lines.find((l) => l.slug === slug && (l.size || null) === (size || null));
  if (!line) return res.status(400).json({ error: "That item is not on this order." });

  const product = products.find((p) => p.slug === slug);
  if (product?.madeToOrder)
    return res.status(400).json({ error: "Made-to-order pieces are non-returnable per policy." });
  if (line.engraving)
    return res.status(400).json({ error: "Engraved pieces are non-returnable per policy." });

  if (db.returns.some((r) => r.orderId === order.orderId && r.slug === slug && (r.size || null) === (size || null) && !RETURN_TERMINAL.includes(r.status) && r.status !== "Refunded"))
    return res.status(400).json({ error: "A return for this item is already in progress." });

  if (!["return", "exchange"].includes(type))
    return res.status(400).json({ error: "Choose return or exchange." });
  if (!reason) return res.status(400).json({ error: "Please pick a reason." });

  const request = {
    id: newId("RET"),
    orderId: order.orderId,
    phone: order.customer.phone,
    slug,
    size: size || null,
    itemName: line.name,
    qty: line.qty,
    refundAmount: line.lineTotal,
    type,
    reason,
    comments: comments || null,
    status: "Requested",
    history: [{ status: "Requested", at: new Date().toISOString() }],
  };
  db.returns.push(request);
  notify(
    request.phone,
    "return",
    `Your ${type} request ${request.id} for ${line.name} is registered. We'll schedule an insured pickup and keep you posted.`
  );
  save();
  res.status(201).json(request);
});

app.get("/api/admin/returns", requireAdmin, (req, res) => {
  res.json({ flow: RETURN_FLOW, terminal: RETURN_TERMINAL, returns: [...db.returns].reverse() });
});

app.patch("/api/admin/returns/:id", requireAdmin, (req, res) => {
  const request = db.returns.find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Return not found" });
  const to = req.body?.status;
  const note = req.body?.note || null;

  const fi = RETURN_FLOW.indexOf(request.status);
  const ti = RETURN_FLOW.indexOf(to);
  const forward = ti !== -1 && fi !== -1 && ti === fi + 1;
  const qcFail = to === "QC Failed" && request.status === "Received at Warehouse";
  const cancel = to === "Cancelled" && ["Requested", "Pickup Scheduled"].includes(request.status);
  if (!forward && !qcFail && !cancel)
    return res.status(400).json({ error: `Cannot move from "${request.status}" to "${to}"` });

  request.status = to;
  request.history.push({ status: to, at: new Date().toISOString(), note });
  // A QC-passed piece is back on the shelf (FR-INV).
  if (to === "QC Passed") {
    const product = products.find((p) => p.slug === request.slug);
    if (product && Number.isFinite(product.stock)) product.stock += request.qty;
  }
  audit("return", `${request.id}: → ${to}`);
  const RETURN_MESSAGES = {
    "Pickup Scheduled": `Pickup for return ${request.id} (${request.itemName}) is scheduled — our insured courier will call ahead.`,
    "Received at Warehouse": `Return ${request.id} has reached our warehouse and is queued for quality check.`,
    "QC Passed": `Return ${request.id} passed quality check. Your refund of ₹${request.refundAmount.toLocaleString("en-IN")} will be initiated shortly.`,
    "QC Failed": `Return ${request.id} did not clear quality check${note ? ` (${note})` : ""}. Our team will call you with the details.`,
    "Refund Initiated": `Refund of ₹${request.refundAmount.toLocaleString("en-IN")} for return ${request.id} is initiated to your original payment method.`,
    Refunded: `Refund for return ${request.id} is complete. Thank you for your patience.`,
    Cancelled: `Return ${request.id} has been cancelled as requested.`,
  };
  if (RETURN_MESSAGES[to]) notify(request.phone, "return", RETURN_MESSAGES[to]);
  save();
  res.json({ ok: true, request });
});

// ---------------------------------------------------- reviews (FR-PDP-08)
if (!db.reviews || typeof db.reviews !== "object") db.reviews = {};

function reviewSummary(slug) {
  const list = db.reviews[slug] || [];
  const avg = list.length
    ? Number((list.reduce((a, r) => a + r.rating, 0) / list.length).toFixed(1))
    : null;
  return {
    count: list.length,
    average: avg,
    reviews: [...list].reverse().map(({ phone, ...pub }) => pub),
  };
}

app.get("/api/products/:slug/reviews", (req, res) => {
  res.json(reviewSummary(req.params.slug));
});

app.post("/api/products/:slug/reviews", (req, res) => {
  const slug = req.params.slug;
  const product = products.find((p) => p.slug === slug);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const { name, phone, rating, title, text } = req.body || {};
  const stars = Number(rating);
  if (!name || !text) return res.status(400).json({ error: "Name and review text are required." });
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    return res.status(400).json({ error: "Rating must be 1–5 stars." });

  const cleanPhone = String(phone || "").trim();
  const verified = db.orders.some(
    (o) => o.customer.phone === cleanPhone && o.lines.some((l) => l.slug === slug)
  );

  if (!db.reviews[slug]) db.reviews[slug] = [];
  const review = {
    name,
    phone: cleanPhone || null,
    rating: stars,
    title: title || null,
    text,
    verified,
    at: new Date().toISOString(),
  };
  db.reviews[slug].push(review);
  save();
  const { phone: _p, ...pub } = review;
  res.status(201).json({ ...pub, summary: reviewSummary(slug) });
});

// ---------------------------------------------------- appointments
// BRD FR-CMS-09 / FR-PDP-10 — book a showroom visit, optionally against
// a specific piece, which the store keeps ready at the counter.
const DEFAULT_STORES = [
  { key: "indore-palasia", name: "Indore — Palasia", address: "12 Palasia Square, A.B. Road, Indore 452001", hours: "10:30 am – 8:30 pm", phone: "+91 731 400 1122" },
  { key: "bhopal-mp-nagar", name: "Bhopal — MP Nagar", address: "Plot 45, Zone-I, MP Nagar, Bhopal 462011", hours: "11:00 am – 8:00 pm", phone: "+91 755 466 8890" },
  { key: "ujjain-freeganj", name: "Ujjain — Freeganj", address: "78 Freeganj Tower Road, Ujjain 456010", hours: "10:30 am – 8:00 pm", phone: "+91 734 255 6677" },
];
// Branches live in the store (Admin → Settings → Showrooms); the constant
// above only seeds a fresh database and answers "restore standard branches".
if (!Array.isArray(db.stores) || db.stores.length === 0)
  db.stores = structuredClone(DEFAULT_STORES);
const APPOINTMENT_SLOTS = ["11:00 am", "12:30 pm", "2:00 pm", "4:00 pm", "5:30 pm", "7:00 pm"];

if (!Array.isArray(db.appointments)) db.appointments = [];

app.get("/api/stores", (req, res) => res.json({ stores: db.stores, slots: APPOINTMENT_SLOTS }));

// Replace the whole branch list at once (same wholesale pattern as the
// header/footer links). Appointments and pickup orders keep the branch
// name they were created with, so edits never rewrite history.
app.patch("/api/admin/stores", requireAdmin, (req, res) => {
  const raw = req.body?.stores;
  if (!Array.isArray(raw))
    return res.status(400).json({ error: "Send stores as a list." });
  if (raw.length === 0) {
    db.stores = structuredClone(DEFAULT_STORES);
    audit("stores", "restored the standard branches");
    save();
    return res.json({ ok: true, stores: db.stores });
  }
  if (raw.length > 8)
    return res.status(400).json({ error: "Keep it to 8 branches or fewer." });
  const clean = [];
  const seen = new Set();
  for (const entry of raw) {
    const name = String(entry?.name || "").trim().slice(0, 60);
    const address = String(entry?.address || "").trim().slice(0, 140);
    const hours = String(entry?.hours || "").trim().slice(0, 40);
    const phone = String(entry?.phone || "").trim().slice(0, 20);
    if (!name || !address)
      return res.status(400).json({ error: "Every branch needs a name and an address." });
    if (phone && !/^\+?[\d\s\-()]{8,20}$/.test(phone))
      return res.status(400).json({ error: `"${phone}" doesn't look like a phone number.` });
    let key =
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "branch";
    while (seen.has(key)) key += "-2";
    seen.add(key);
    clean.push({ key, name, address, hours, phone });
  }
  db.stores = clean;
  audit("stores", `${clean.length} branch${clean.length === 1 ? "" : "es"}: ${clean.map((s) => s.name).join(", ")}`);
  save();
  res.json({ ok: true, stores: db.stores });
});

app.post("/api/appointments", (req, res) => {
  const { store, date, slot, name, phone, productSlug, notes } = req.body || {};
  if (!db.stores.some((s) => s.key === store))
    return res.status(400).json({ error: "Choose a showroom." });
  if (!APPOINTMENT_SLOTS.includes(slot))
    return res.status(400).json({ error: "Choose a time slot." });
  const day = new Date(`${date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(day.getTime()) || day < today)
    return res.status(400).json({ error: "Pick today or a future date." });
  if (!name || !/^[6-9]\d{9}$/.test(String(phone || "")))
    return res.status(400).json({ error: "Enter your name and a valid 10-digit mobile number." });

  const product = productSlug ? products.find((p) => p.slug === productSlug) : null;

  const appointment = {
    id: newId("APT"),
    store,
    storeName: db.stores.find((s) => s.key === store).name,
    date,
    slot,
    name,
    phone: String(phone),
    productSlug: product?.slug || null,
    productName: product?.name || null,
    notes: notes || null,
    status: "Requested",
    createdAt: new Date().toISOString(),
  };
  db.appointments.push(appointment);
  notify(
    appointment.phone,
    "appointment",
    `Appointment ${appointment.id} requested at ${appointment.storeName} for ${date}, ${slot}${appointment.productName ? ` to view ${appointment.productName}` : ""}. We'll confirm shortly.`
  );
  save();
  res.status(201).json(appointment);
});

app.get("/api/appointments/my", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phone))
    return res.status(400).json({ error: "Enter the 10-digit mobile used for booking." });
  res.json([...db.appointments.filter((a) => a.phone === phone)].reverse());
});

app.get("/api/admin/appointments", requireAdmin, (req, res) => {
  res.json({ appointments: [...db.appointments].reverse() });
});

app.patch("/api/admin/appointments/:id", requireAdmin, (req, res) => {
  const appointment = db.appointments.find((a) => a.id === req.params.id);
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });
  const to = req.body?.status;
  const allowed = {
    Requested: ["Confirmed", "Cancelled"],
    Confirmed: ["Completed", "Cancelled"],
  };
  if (!(allowed[appointment.status] || []).includes(to))
    return res.status(400).json({ error: `Cannot move from "${appointment.status}" to "${to}"` });
  appointment.status = to;
  if (to === "Confirmed")
    notify(appointment.phone, "appointment", `Appointment ${appointment.id} is confirmed — ${appointment.storeName}, ${appointment.date} at ${appointment.slot}. ${appointment.productName ? `${appointment.productName} will be kept ready at the counter.` : "We look forward to hosting you."}`);
  if (to === "Cancelled")
    notify(appointment.phone, "appointment", `Appointment ${appointment.id} has been cancelled. You can rebook anytime at dpjewellers.example/appointments.`);
  audit("appointment", `${appointment.id}: → ${to}`);
  save();
  res.json({ ok: true, appointment });
});

// ------------------------------------------------------------------ static
// Locally the backend also serves the built storefront. In cloud deploys
// (Render + Vercel) the frontend lives elsewhere, so when no dist exists the
// non-API routes answer with a service banner instead of a 404 — keeps the
// platform health checks green.
const DIST_CANDIDATES = [
  path.join(__dirname, "..", "dp-frontend", "dist"),
  path.join(__dirname, "..", "dp-frontent", "dist"),
  path.join(__dirname, "..", "..", "dp-frontend", "dist"),
];
const dist = DIST_CANDIDATES.find((d) => fs.existsSync(path.join(d, "index.html")));
if (dist) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    res.sendFile(path.join(dist, "index.html"), (err) => err && next());
  });
} else {
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.json({ ok: true, service: "dp-jewellers-api", health: "/api/health" });
  });
}

app.listen(PORT, () => {
  console.log(`DP Jewellers API running on http://localhost:${PORT}`);
  console.log(`Admin console: http://localhost:${PORT}/admin (key: ${ADMIN_KEY})`);
});
