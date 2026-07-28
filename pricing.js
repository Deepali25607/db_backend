// Dynamic pricing engine (BRD 7.2)
// Price = (net metal weight x metal rate) + making charges + stone value
//         + other charges (hallmarking, certification) + GST
// GST is applied per component (BRD FR-PRC-06): jewellery value vs. making charges.
// An optional markdown percentage (site-wide sale / per-product discount) comes
// off the pre-tax subtotal; GST is then charged on the actual consideration.

const DEFAULT_TAX = { jewelleryGstPct: 3, makingGstPct: 5 };

function metalRate(rates, metalType, purity) {
  const table = rates[metalType];
  if (!table) return null;
  const rate = table[purity];
  return typeof rate === "number" ? rate : null;
}

function round(n) {
  return Math.round(n);
}

function computePrice(product, rates, tax = DEFAULT_TAX, discountPct = 0) {
  const { metal, stones = [], making, otherCharges = {} } = product;

  const rate = metalRate(rates, metal.type, metal.purity);
  if (rate === null) {
    throw new Error(`No rate configured for ${metal.type} ${metal.purity}`);
  }

  const metalValue = metal.netWeight * rate;

  const stoneValue = stones.reduce(
    (sum, s) => sum + s.caratTotal * s.ratePerCarat,
    0
  );

  let makingCharges;
  switch (making.basis) {
    case "perGram":
      makingCharges = metal.netWeight * making.value;
      break;
    case "percent":
      makingCharges = (metalValue * making.value) / 100;
      break;
    case "flat":
      makingCharges = making.value;
      break;
    default:
      throw new Error(`Unknown making-charge basis: ${making.basis}`);
  }

  const otherValue = Object.values(otherCharges).reduce((a, b) => a + b, 0);

  // markdown scales every pre-tax component; GST is charged on what is
  // actually paid, so the discounted base feeds both GST buckets
  const pct = Math.min(90, Math.max(0, Number(discountPct) || 0));
  const factor = 1 - pct / 100;

  const gstOnJewellery =
    ((metalValue + stoneValue + otherValue) * factor * tax.jewelleryGstPct) / 100;
  const gstOnMaking = (makingCharges * factor * tax.makingGstPct) / 100;

  const subtotal = metalValue + stoneValue + makingCharges + otherValue;
  const discountValue = subtotal * (pct / 100);
  const taxable = subtotal - discountValue;
  const gst = gstOnJewellery + gstOnMaking;
  const gstFull = gst / factor; // GST as it would be with no markdown (for the MRP)

  return {
    metalRatePerGram: rate,
    metalValue: round(metalValue),
    stoneValue: round(stoneValue),
    makingCharges: round(makingCharges),
    otherCharges: round(otherValue),
    subtotal: round(subtotal),
    discountPct: pct,
    discountValue: round(discountValue),
    taxable: round(taxable),
    gst: round(gst),
    gstDetail: {
      onJewellery: round(gstOnJewellery),
      onMaking: round(gstOnMaking),
      jewelleryGstPct: tax.jewelleryGstPct,
      makingGstPct: tax.makingGstPct,
    },
    mrpTotal: round(subtotal + gstFull),
    total: round(taxable + gst),
  };
}

module.exports = { computePrice, DEFAULT_TAX };
