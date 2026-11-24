// Home banner pricing: 5,000 RWF = 3 seconds, +1,000 RWF per extra second.
// Pure functions, no database.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_RULES, rulesFrom, priceForSeconds, secondsForAmount, resolve, ladder } = require("../src/utils/adPricing");

const rejects = (fn, pattern) => assert.throws(fn, (e) => e.statusCode === 400 && pattern.test(e.message));

describe("ad pricing: seconds → price", () => {
  test("matches the published price table", () => {
    const table = { 3: 5000, 4: 6000, 5: 7000, 6: 8000, 7: 9000, 8: 10000, 9: 11000, 10: 12000, 15: 17000, 20: 22000 };
    for (const [seconds, price] of Object.entries(table)) assert.equal(priceForSeconds(Number(seconds)), price, `${seconds}s`);
  });

  test("accepts whole seconds sent as text, rejects everything else", () => {
    assert.equal(priceForSeconds("10"), 12000);
    rejects(() => priceForSeconds(2), /shortest ad is 3 seconds/);
    rejects(() => priceForSeconds(0), /shortest ad/);
    rejects(() => priceForSeconds(-5), /shortest ad/);
    rejects(() => priceForSeconds(3.5), /whole number/);
    rejects(() => priceForSeconds("abc"), /whole number/);
    rejects(() => priceForSeconds(61), /at most 60 seconds/);
  });
});

describe("ad pricing: amount → seconds", () => {
  test("5,000 RWF is 3 seconds, 12,000 is 10, 22,000 is 20", () => {
    assert.equal(secondsForAmount(5000), 3);
    assert.equal(secondsForAmount(12000), 10);
    assert.equal(secondsForAmount(22000), 20);
    assert.equal(secondsForAmount("17000"), 15);
  });

  test("below the minimum, between prices, or not a whole number is refused", () => {
    rejects(() => secondsForAmount(4999), /minimum payment is 5,000 RWF for 3 seconds/);
    rejects(() => secondsForAmount(0), /minimum payment/);
    rejects(() => secondsForAmount(-1000), /minimum payment/);
    rejects(() => secondsForAmount(5500), /does not match a banner time.*5,000 RWF or 6,000 RWF/);
    rejects(() => secondsForAmount(12001), /does not match/);
    rejects(() => secondsForAmount(5000.5), /whole Rwandan francs/);
    rejects(() => secondsForAmount("12k"), /whole Rwandan francs/);
    rejects(() => secondsForAmount(1e9), /at most 60 seconds/);
    rejects(() => secondsForAmount(999999999), /at most 60 seconds/); // not on a price step, but the cap is the useful answer
  });

  test("price and seconds are inverses on every second", () => {
    for (let s = DEFAULT_RULES.baseSeconds; s <= DEFAULT_RULES.maxSeconds; s += 1) assert.equal(secondsForAmount(priceForSeconds(s)), s);
  });
});

describe("ad pricing: resolve what a client sent", () => {
  test("seconds only, amount only, or both when they agree", () => {
    assert.deepEqual(resolve({ seconds: 10 }), { seconds: 10, amount: 12000 });
    assert.deepEqual(resolve({ amount: 22000 }), { seconds: 20, amount: 22000 });
    assert.deepEqual(resolve({ seconds: "3", amount: "5000" }), { seconds: 3, amount: 5000 });
  });

  test("a client cannot pay less than the ad costs", () => {
    rejects(() => resolve({ seconds: 20, amount: 5000 }), /20 seconds costs 22,000 RWF, not 5,000 RWF/);
    rejects(() => resolve({ seconds: 3, amount: 12000 }), /costs 5,000 RWF/);
    rejects(() => resolve({}), /Choose how many seconds/);
    rejects(() => resolve({ seconds: "", amount: null }), /Choose how many seconds/);
  });
});

describe("ad pricing: admin settings", () => {
  test("rules follow the settings and fall back to the defaults", () => {
    assert.deepEqual(rulesFrom({}), DEFAULT_RULES);
    assert.deepEqual(rulesFrom({ adBasePrice: "garbage", adMaxSeconds: -4 }), DEFAULT_RULES);
    const custom = rulesFrom({ adBasePrice: 4000, adBaseSeconds: 2, adExtraSecondPrice: 500, adMaxSeconds: 30 });
    assert.equal(priceForSeconds(4, custom), 5000);
    assert.equal(secondsForAmount(5000, custom), 4);
    rejects(() => priceForSeconds(31, custom), /at most 30 seconds/);
  });

  test("the ladder lists the published examples", () => {
    assert.deepEqual(ladder().map((r) => `${r.seconds}:${r.amount}`), ["3:5000", "4:6000", "5:7000", "6:8000", "7:9000", "8:10000", "9:11000", "10:12000", "15:17000", "20:22000"]);
  });
});
