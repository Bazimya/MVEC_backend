const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { isLive, startupReport, testPayments, simulatedPaymentsAllowed } = require("../src/config/env");

const safe = {
  JWT_SECRET: "a".repeat(48),
  DB_PASSWORD: "db-pass",
  FRONTEND_URL: "https://ikiguzi.com",
  SMS_PROVIDER: "pindo",
  PINDO_API_TOKEN: "token",
  MOMO_BASE_URL: "https://momo.example",
  EMAIL_USER: "mail@ikiguzi.com",
  EMAIL_PASS: "pass",
  FIREBASE_PROJECT_ID: "ikiguzi",
  FIREBASE_CLIENT_EMAIL: "push@ikiguzi.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----",
};

describe("development or live", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = original; });

  it("only development and test are development servers", () => {
    process.env.NODE_ENV = "development";
    assert.equal(isLive(), false);
    process.env.NODE_ENV = "test";
    assert.equal(isLive(), false);
    process.env.NODE_ENV = "staging";
    assert.equal(isLive(), true);
  });

  it("a server that forgot NODE_ENV is live", () => {
    delete process.env.NODE_ENV;
    assert.equal(isLive(), true);
  });
});

describe("startup report", () => {
  it("a fully configured server has nothing to fix", () => {
    assert.deepEqual(startupReport(safe), { errors: [], warnings: [] });
  });

  it("lists every unsafe setting at once", () => {
    const { errors } = startupReport({
      JWT_SECRET: "your_jwt_secret_key_here",
      FRONTEND_URL: "http://localhost:5173",
      MOMO_WEBHOOK_SECRET: "change_me_momo_webhook_secret",
      ADMIN_PASSWORD: "your_admin_password_here",
      SMS_PROVIDER: "log",
      SHOW_RIDER_CODES: "false",
    });
    assert.equal(errors.length, 6);
    for (const key of ["JWT_SECRET", "DB_PASSWORD", "FRONTEND_URL", "MOMO_WEBHOOK_SECRET", "ADMIN_PASSWORD", "SMS gateway"]) {
      assert.ok(errors.some((e) => e.includes(key)), key);
    }
  });

  it("until SMS is set up, riders see codes on screen by default, so a live server starts, with warnings", () => {
    for (const flag of [undefined, "", "true"]) {
      const { errors, warnings } = startupReport({ ...safe, SMS_PROVIDER: "", SHOW_RIDER_CODES: flag });
      assert.deepEqual(errors, []);
      assert.ok(warnings.some((w) => w.includes("SMS gateway")));
      assert.ok(warnings.some((w) => w.includes("SHOW_RIDER_CODES=false")));
    }
    assert.ok(startupReport({ ...safe, SMS_PROVIDER: "", SHOW_RIDER_CODES: "false" }).errors.some((e) => e.includes("SMS gateway")));
  });

  it("missing payments and email are warnings, not errors", () => {
    const { errors, warnings } = startupReport({ ...safe, MOMO_BASE_URL: "", EMAIL_USER: "", ALLOW_UNSIGNED_WEBHOOKS: "true" });
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 3);
  });
});

describe("TEST_PAYMENTS (simulated payments on a live server)", () => {
  const original = { NODE_ENV: process.env.NODE_ENV, TEST_PAYMENTS: process.env.TEST_PAYMENTS };
  afterEach(() => {
    for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it("is off unless set to on, true or 1", () => {
    for (const v of [undefined, "", "off", "false", "no"]) assert.equal(testPayments({ TEST_PAYMENTS: v }), false);
    for (const v of ["on", "ON", "true", "1", " on "]) assert.equal(testPayments({ TEST_PAYMENTS: v }), true);
  });

  it("a live server simulates only with the flag; development always may", () => {
    process.env.NODE_ENV = "production";
    delete process.env.TEST_PAYMENTS;
    assert.equal(simulatedPaymentsAllowed(), false);
    process.env.TEST_PAYMENTS = "on";
    assert.equal(simulatedPaymentsAllowed(), true);
    process.env.NODE_ENV = "development";
    delete process.env.TEST_PAYMENTS;
    assert.equal(simulatedPaymentsAllowed(), true);
  });

  it("the startup report warns, never refuses, while test payments are on", () => {
    const { errors, warnings } = startupReport({ ...safe, MOMO_BASE_URL: "", TEST_PAYMENTS: "on" });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes("TEST_PAYMENTS is on")));
    assert.ok(!warnings.some((w) => w.includes("No payment gateway")));
  });
});
