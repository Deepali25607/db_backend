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

// discount may be a plain percentage (comes off the whole pre-tax subtotal,
// the historical behaviour) or a spec { pct, base: "price"|"making", label }.
// A "making" discount reduces only the making-charge component, so GST on
// jewellery value stays full while GST on making follows the reduced base.
function computePrice(product, rates, tax = DEFAULT_TAX, discount = 0) {
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

  const spec =
    discount !== null && typeof discount === "object"
      ? {
          pct: Math.min(90, Math.max(0, Number(discount.pct) || 0)),
          base: discount.base === "making" ? "making" : "price",
          label: discount.label || null,
        }
      : { pct: Math.min(90, Math.max(0, Number(discount) || 0)), base: "price", label: null };

  const jewelleryValue = metalValue + stoneValue + otherValue;
  const subtotal = jewelleryValue + makingCharges;

  // GST is charged on the actual consideration per component
  let discountValue, jewelleryBase, makingBase;
  if (spec.base === "making") {
    discountValue = makingCharges * (spec.pct / 100);
    jewelleryBase = jewelleryValue;
    makingBase = makingCharges - discountValue;
  } else {
    const factor = 1 - spec.pct / 100;
    discountValue = subtotal * (spec.pct / 100);
    jewelleryBase = jewelleryValue * factor;
    makingBase = makingCharges * factor;
  }

  const gstOnJewellery = (jewelleryBase * tax.jewelleryGstPct) / 100;
  const gstOnMaking = (makingBase * tax.makingGstPct) / 100;

  const taxable = subtotal - discountValue;
  const gst = gstOnJewellery + gstOnMaking;
  // GST as it would be with no markdown at all (for the struck MRP)
  const gstFull =
    (jewelleryValue * tax.jewelleryGstPct + makingCharges * tax.makingGstPct) / 100;

  // effective percentage of the whole pre-tax value, for badges and flags
  const displayPct =
    spec.base === "making"
      ? Math.round(((discountValue / (subtotal || 1)) * 100) * 10) / 10
      : spec.pct;

  return {
    metalRatePerGram: rate,
    metalValue: round(metalValue),
    stoneValue: round(stoneValue),
    makingCharges: round(makingCharges),
    otherCharges: round(otherValue),
    subtotal: round(subtotal),
    discountPct: displayPct,
    discountBase: spec.base,
    discountLabel: spec.label,
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
