// External-provider adapters. Every integration here goes live purely via
// environment variables — with none set, the built-in simulators keep the
// site fully working for dev and demo. Route code never branches on vendor
// names; it asks this module.
//
//   Payments : RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET   (+ RAZORPAY_WEBHOOK_SECRET)
//   SMS      : MSG91_AUTH_KEY + MSG91_SENDER
//              or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
//   Rates    : METALS_API_KEY                            (metals-api.com)

const crypto = require("crypto");

const env = process.env;

/* ------------------------------------------------------------- payments */
const payments = {
  get mode() {
    return env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? "razorpay" : "simulated";
  },
  get keyId() {
    return env.RAZORPAY_KEY_ID || null;
  },

  // Creates the gateway-side order; the returned id is what Razorpay
  // Checkout on the storefront needs to open.
  async createGatewayOrder(amountInr, receipt) {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amountInr * 100), // paise
        currency: "INR",
        receipt,
      }),
    });
    if (!res.ok) throw new Error(`Razorpay order creation failed (${res.status})`);
    return res.json(); // { id: "order_...", ... }
  },

  // Checkout signature: HMAC-SHA256(orderId|paymentId, key secret).
  verifyCheckoutSignature({ gatewayOrderId, paymentId, signature }, secret = env.RAZORPAY_KEY_SECRET) {
    if (!gatewayOrderId || !paymentId || !signature || !secret) return false;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${gatewayOrderId}|${paymentId}`)
      .digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(String(signature), "hex"));
    } catch {
      return false;
    }
  },

  // Webhook signature: HMAC-SHA256 of the raw request body.
  verifyWebhookSignature(rawBody, signature, secret = env.RAZORPAY_WEBHOOK_SECRET) {
    if (!rawBody || !signature || !secret) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(String(signature), "hex"));
    } catch {
      return false;
    }
  },
};

/* ------------------------------------------------------------------ sms */
const sms = {
  get mode() {
    if (env.MSG91_AUTH_KEY) return "msg91";
    if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) return "twilio";
    return "simulated";
  },

  // Fire-and-forget transactional SMS. Returns {delivered, detail}.
  async send(phone, message) {
    try {
      if (sms.mode === "msg91") {
        const res = await fetch("https://control.msg91.com/api/v5/flow/", {
          method: "POST",
          headers: { authkey: env.MSG91_AUTH_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: env.MSG91_SENDER || "DPJWLR",
            short_url: "0",
            recipients: [{ mobiles: `91${phone}`, message }],
          }),
        });
        return { delivered: res.ok, detail: `msg91 ${res.status}` };
      }
      if (sms.mode === "twilio") {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization:
                "Basic " +
                Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: `+91${phone}`, From: env.TWILIO_FROM, Body: message }),
          }
        );
        return { delivered: res.ok, detail: `twilio ${res.status}` };
      }
    } catch (e) {
      return { delivered: false, detail: e.message };
    }
    return { delivered: false, detail: "simulated" };
  },
};

/* ------------------------------------------------------------ rate feed */
const TROY_OUNCE_GRAMS = 31.1035;

const rateFeed = {
  get mode() {
    return env.METALS_API_KEY ? "metals-api" : "manual";
  },

  // Returns fine-metal ₹/gram: { gold24K, silver, platinum }.
  // metals-api quotes XAU/XAG/XPT as troy ounces per unit of base currency,
  // so the INR price per gram is 1 / (rate × grams-per-ounce)… inverted:
  async fetchFineRates() {
    const res = await fetch(
      `https://metals-api.com/api/latest?access_key=${env.METALS_API_KEY}&base=INR&symbols=XAU,XAG,XPT`
    );
    if (!res.ok) throw new Error(`rate feed HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success || !data.rates) throw new Error(`rate feed error: ${data.error?.type || "no rates"}`);
    const perGram = (symbol) => 1 / data.rates[symbol] / TROY_OUNCE_GRAMS;
    return {
      gold24K: perGram("XAU"),
      silver: perGram("XAG"),
      platinum: perGram("XPT"),
    };
  },
};

function status() {
  return { payments: payments.mode, sms: sms.mode, rates: rateFeed.mode };
}

module.exports = { payments, sms, rateFeed, status };
