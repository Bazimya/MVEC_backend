// Home banner pricing: one flat price per ad, 5 seconds a turn. Pure functions, no database.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { SLIDE_SECONDS, DEFAULT_RULES, rulesFrom, resolve } = require("../src/utils/adPricing");

describe("ad pricing", () => {
  test("every ad shows 5 seconds and costs 5,000 RWF by default", () => {
    assert.equal(SLIDE_SECONDS, 5);
    assert.deepEqual(resolve(), { seconds: 5, amount: 5000 });
    assert.deepEqual(DEFAULT_RULES, { price: 5000, seconds: 5 });
  });

  test("what a client sends never changes the price or the time", () => {
    assert.deepEqual(resolve({ seconds: 60, amount: 1 }), { seconds: 5, amount: 5000 });
  });

  test("the admin's price is used; nonsense falls back to the default", () => {
    assert.deepEqual(resolve(null, rulesFrom({ adPrice: 8000 })), { seconds: 5, amount: 8000 });
    for (const bad of [undefined, 0, -1, "abc", 2.5]) assert.equal(rulesFrom({ adPrice: bad }).price, 5000);
  });
});
