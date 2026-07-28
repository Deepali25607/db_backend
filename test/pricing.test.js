// Unit tests for the dynamic pricing engine (BRD 7.2 / FR-PRC).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computePrice } = require("../pricing");

const rates = {
  gold: { "22K": 9580, "18K": 7840 },
  silver: { "925": 138 },
  platinum: { PT950: 3520 },
};

test("per-gram making: price = metal + making + other + component GST", () => {
  const p = computePrice(
    {
      metal: { type: "gold", purity: "22K", netWeight: 10 },
      stones: [],
      making: { basis: "perGram", value: 500 },
      otherCharges: { hallmarking: 45 },
    },
    rates
  );
  assert.equal(p.metalValue, 95800);           // 10 g × 9580
  assert.equal(p.makingCharges, 5000);         // 10 g × 500
  assert.equal(p.otherCharges, 45);
  assert.equal(p.subtotal, 100845);
  assert.equal(p.gstDetail.onJewellery, 2875); // 3% of 95845
  assert.equal(p.gstDetail.onMaking, 250);     // 5% of 5000
  assert.equal(p.total, 103970);
});

test("percent making basis computes off metal value", () => {
  const p = computePrice(
    {
      metal: { type: "gold", purity: "18K", netWeight: 5 },
      stones: [],
      making: { basis: "percent", value: 12 },
      otherCharges: {},
    },
    rates
  );
  assert.equal(p.metalValue, 39200);
  assert.equal(p.makingCharges, 4704); // 12% of 39200
});

test("stone value joins the jewellery GST bucket", () => {
  const p = computePrice(
    {
      metal: { type: "platinum", purity: "PT950", netWeight: 4 },
      stones: [{ caratTotal: 0.5, ratePerCarat: 60000 }],
      making: { basis: "flat", value: 8000 },
      otherCharges: {},
    },
    rates
  );
  assert.equal(p.stoneValue, 30000);
  assert.equal(p.gstDetail.onJewellery, Math.round((14080 + 30000) * 0.03));
  assert.equal(p.gstDetail.onMaking, 400);
});

test("markdown discount: off the pre-tax subtotal, GST on the consideration", () => {
  const spec = {
    metal: { type: "gold", purity: "22K", netWeight: 10 },
    stones: [],
    making: { basis: "perGram", value: 500 },
    otherCharges: { hallmarking: 45 },
  };
  const full = computePrice(spec, rates);
  const sale = computePrice(spec, rates, undefined, 20);

  assert.equal(sale.discountPct, 20);
  assert.equal(sale.discountValue, Math.round(100845 * 0.2));
  assert.equal(sale.taxable, 100845 - sale.discountValue);
  // GST buckets are charged on the discounted base (80% of the full base)
  assert.equal(sale.gstDetail.onJewellery, Math.round(95845 * 0.8 * 0.03));
  assert.equal(sale.gstDetail.onMaking, Math.round(5000 * 0.8 * 0.05));
  assert.equal(sale.total, Math.round(sale.taxable + 95845 * 0.8 * 0.03 + 5000 * 0.8 * 0.05));
  // the struck-through MRP equals the undiscounted total; components unchanged
  assert.equal(sale.mrpTotal, full.total);
  assert.equal(sale.metalValue, full.metalValue);
  assert.equal(sale.makingCharges, full.makingCharges);
  // no discount = identical result to the 3-arg call, and the pct is clamped
  assert.equal(computePrice(spec, rates, undefined, 0).total, full.total);
  assert.equal(computePrice(spec, rates, undefined, 120).discountPct, 90);
});

test("unknown purity throws instead of guessing", () => {
  assert.throws(() =>
    computePrice(
      { metal: { type: "gold", purity: "9K", netWeight: 1 }, stones: [], making: { basis: "flat", value: 1 } },
      rates
    )
  );
});
