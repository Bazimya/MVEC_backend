// Operational settings an admin can change from the dashboard (stored in
// platform_settings under "operations"). Read through a short cache so hot
// paths (checkout, listing products, background jobs) don't hit the database.
const PlatformSetting = require("../models/PlatformSetting");

const KEY = "operations";
const DEFAULTS = {
  // Days after an order is shipped / out for delivery before the seller is
  // paid automatically when the buyer neither confirms nor reports a problem.
  // 0 turns automatic release off.
  autoReleaseDays: 1,
  // Paid plans (Seller Premium, Buyer ad-free). Off until Ikiguzi has enough
  // users: while off nobody is charged and every seller keeps full access.
  subscriptionsEnabled: false,
  sellerPremiumPrice: 5000,
  buyerPremiumPrice: 5000,
  // Free plan listing limit, applied only while subscriptions are on.
  freeProductLimit: 50,
  // Days the seller has to respond to a problem report (and the buyer to an
  // offer) before Ikiguzi steps in to decide.
  disputeResponseDays: 3,
  // Days after delivery a buyer can ask to return items. 0 turns returns off.
  returnWindowDays: 7,
  // "Advertise here": the flat fee per product, and how long the ad runs.
  adPricePerProduct: 1000,
  adDays: 7,
  // Home banner pricing (utils/adPricing.js): adBasePrice buys adBaseSeconds in
  // the banner, and each extra second costs adExtraSecondPrice. adDays is how
  // long a booking stays eligible to show once Ikiguzi approves it.
  adBasePrice: 5000,
  adBaseSeconds: 3,
  adExtraSecondPrice: 1000,
  adMaxSeconds: 60,
};
const LIMITS = {
  autoReleaseDays: [0, 30],
  sellerPremiumPrice: [1000, 100000],
  buyerPremiumPrice: [500, 100000],
  freeProductLimit: [1, 10000],
  disputeResponseDays: [1, 14],
  returnWindowDays: [0, 30],
  adPricePerProduct: [100, 1000000],
  adDays: [1, 90],
  adBasePrice: [1000, 1000000],
  adBaseSeconds: [1, 60],
  adExtraSecondPrice: [100, 1000000],
  adMaxSeconds: [3, 300],
};

let cache = { value: null, at: 0 };
const TTL_MS = 30 * 1000;

async function get() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await PlatformSetting.findOne({ settingKey: KEY }).lean();
  cache = { value: { ...DEFAULTS, ...(row?.value || {}) }, at: Date.now() };
  return cache.value;
}

async function update(patch = {}, adminId = null) {
  const current = await get();
  const next = { ...current };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    if (patch[k] === undefined) continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max || (k !== "autoReleaseDays" && !Number.isInteger(v))) {
      throw Object.assign(new Error(`${k} must be a number between ${min} and ${max}.`), { statusCode: 400 });
    }
    next[k] = Math.round(v * 10) / 10;
  }
  if (patch.subscriptionsEnabled !== undefined) next.subscriptionsEnabled = Boolean(patch.subscriptionsEnabled);
  await PlatformSetting.findOneAndUpdate(
    { settingKey: KEY },
    { $set: { settingKey: KEY, value: next, updatedBy: adminId } },
    { upsert: true, new: true },
  );
  cache = { value: next, at: Date.now() };
  return next;
}

module.exports = { DEFAULTS, LIMITS, get, update };
