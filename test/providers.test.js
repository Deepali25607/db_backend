// Unit tests for the go-live provider adapters. No network calls — only
// mode detection and the cryptographic verification used for Razorpay.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const providers = require("../providers");

test("all providers default to simulated/manual without env keys", () => {
  assert.deepEqual(providers.status(), {
    payments: "simulated",
    sms: "simulated",
    rates: "manual",
  });
});

test("checkout signature verifies a correct HMAC and rejects tampering", () => {
  const secret = "test_secret_123";
  const gatewayOrderId = "order_ABC123";
  const paymentId = "pay_XYZ789";
  const good = crypto.createHmac("sha256", secret).update(`${gatewayOrderId}|${paymentId}`).digest("hex");

  assert.equal(
    providers.payments.verifyCheckoutSignature({ gatewayOrderId, paymentId, signature: good }, secret),
    true
  );
  const tampered = good.replace(/^./, good[0] === "0" ? "1" : "0");
  assert.equal(
    providers.payments.verifyCheckoutSignature({ gatewayOrderId, paymentId, signature: tampered }, secret),
    false
  );
  // wrong payment id → signature no longer matches
  assert.equal(
    providers.payments.verifyCheckoutSignature({ gatewayOrderId, paymentId: "pay_OTHER", signature: good }, secret),
    false
  );
  // garbage / missing inputs never throw, only refuse
  assert.equal(providers.payments.verifyCheckoutSignature({ gatewayOrderId, paymentId, signature: "zz" }, secret), false);
  assert.equal(providers.payments.verifyCheckoutSignature({}, secret), false);
});

test("webhook signature verifies raw-body HMAC", () => {
  const secret = "whsec_456";
  const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
  const good = crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(providers.payments.verifyWebhookSignature(body, good, secret), true);
  assert.equal(providers.payments.verifyWebhookSignature(body, good.slice(0, -2) + "ff", secret), false);
  assert.equal(providers.payments.verifyWebhookSignature(body, good, undefined), false);
});

test("simulated SMS send reports undelivered without throwing", async () => {
  const r = await providers.sms.send("9800000000", "test");
  assert.equal(r.delivered, false);
  assert.equal(r.detail, "simulated");
});
