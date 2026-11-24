// Home page ad pricing. Pure functions: the server is the only place that
// prices an ad, so a client can never choose what it pays.
//
//   price   = basePrice + (seconds - baseSeconds) × extraSecondPrice
//   seconds = baseSeconds + (amount - basePrice) ÷ extraSecondPrice
//
// With the defaults, 5,000 RWF buys 3 seconds and every extra second costs
// 1,000 RWF: 12,000 RWF = 10 seconds, 22,000 RWF = 20 seconds.
const DEFAULT_RULES = Object.freeze({ basePrice: 5000, baseSeconds: 3, extraSecondPrice: 1000, maxSeconds: 60 });

const httpError = (message) => Object.assign(new Error(message), { statusCode: 400 });
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const isWhole = (v) => typeof v === "number" ? Number.isInteger(v) : /^\d+$/.test(String(v ?? "").trim());
const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/** Pricing rules from the admin settings (platformSettings), falling back to the defaults. */
function rulesFrom(settings = {}) {
  const pick = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    basePrice: pick(settings.adBasePrice, DEFAULT_RULES.basePrice),
    baseSeconds: pick(settings.adBaseSeconds, DEFAULT_RULES.baseSeconds),
    extraSecondPrice: pick(settings.adExtraSecondPrice, DEFAULT_RULES.extraSecondPrice),
    maxSeconds: pick(settings.adMaxSeconds, DEFAULT_RULES.maxSeconds),
  };
}

/** Price of `seconds` of banner time. Throws a 400 for anything outside the rules. */
function priceForSeconds(seconds, rules = DEFAULT_RULES) {
  if (!isWhole(seconds)) throw httpError("Choose a whole number of seconds, for example 5.");
  const s = Number(seconds);
  if (s < rules.baseSeconds) throw httpError(`The shortest ad is ${rules.baseSeconds} seconds (${money(rules.basePrice)}).`);
  if (s > rules.maxSeconds) throw httpError(`An ad can run at most ${rules.maxSeconds} seconds in the banner.`);
  return rules.basePrice + (s - rules.baseSeconds) * rules.extraSecondPrice;
}

/** Seconds that `amount` buys. The amount must be exactly a price on the ladder. */
function secondsForAmount(amount, rules = DEFAULT_RULES) {
  if (!isWhole(amount)) throw httpError("Enter the amount in whole Rwandan francs, for example 12000.");
  const a = Number(amount);
  if (a < rules.basePrice) throw httpError(`The minimum payment is ${money(rules.basePrice)} for ${rules.baseSeconds} seconds.`);
  const top = rules.basePrice + (rules.maxSeconds - rules.baseSeconds) * rules.extraSecondPrice;
  if (a > top) throw httpError(`An ad can run at most ${rules.maxSeconds} seconds (${money(top)}).`);
  const extra = a - rules.basePrice;
  if (extra % rules.extraSecondPrice !== 0) {
    const down = rules.basePrice + Math.floor(extra / rules.extraSecondPrice) * rules.extraSecondPrice;
    throw httpError(`${money(a)} does not match a banner time. Each extra second costs ${money(rules.extraSecondPrice)}: try ${money(down)} or ${money(down + rules.extraSecondPrice)}.`);
  }
  return rules.baseSeconds + extra / rules.extraSecondPrice;
}

/**
 * Works out { seconds, amount } from what a client sent: seconds, an amount, or
 * both (which must agree). Anything else is a 400, so a tampered request can
 * never pay less than the ad costs.
 */
function resolve({ seconds, amount } = {}, rules = DEFAULT_RULES) {
  if (!has(seconds) && !has(amount)) throw httpError("Choose how many seconds your ad should run, or the amount you want to spend.");
  const fromSeconds = has(seconds) ? priceForSeconds(seconds, rules) : null;
  const fromAmount = has(amount) ? secondsForAmount(amount, rules) : null;
  if (fromSeconds !== null && fromAmount !== null && (fromAmount !== Number(seconds) || fromSeconds !== Number(amount))) {
    throw httpError(`${seconds} seconds costs ${money(fromSeconds)}, not ${money(amount)}.`);
  }
  const s = fromSeconds !== null ? Number(seconds) : fromAmount;
  return { seconds: s, amount: priceForSeconds(s, rules) };
}

/** The price ladder for display: [{ seconds, amount }]. */
function ladder(rules = DEFAULT_RULES, points = [3, 4, 5, 6, 7, 8, 9, 10, 15, 20]) {
  return points.filter((s) => s >= rules.baseSeconds && s <= rules.maxSeconds).map((s) => ({ seconds: s, amount: priceForSeconds(s, rules) }));
}

module.exports = { DEFAULT_RULES, rulesFrom, priceForSeconds, secondsForAmount, resolve, ladder };
