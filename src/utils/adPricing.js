// Home page ad pricing. Every ad gets the same time in the banner
// (SLIDE_SECONDS, 5 seconds each turn) and costs one flat price, which Ikiguzi
// sets in the admin settings (adPrice, default 5,000 RWF for adDays). The
// server is the only place that prices an ad, so a client can never choose
// what it pays or how long its ad shows.
const SLIDE_SECONDS = 5;
const DEFAULT_RULES = Object.freeze({ price: 5000, seconds: SLIDE_SECONDS });

/** Pricing rules from the admin settings (platformSettings), falling back to the defaults. */
function rulesFrom(settings = {}) {
  const price = Number(settings.adPrice);
  return { price: Number.isInteger(price) && price > 0 ? price : DEFAULT_RULES.price, seconds: SLIDE_SECONDS };
}

/** What one ad costs and how long it shows. Whatever the client sent is ignored. */
function resolve(_ignored, rules = DEFAULT_RULES) {
  return { seconds: SLIDE_SECONDS, amount: rules.price };
}

module.exports = { SLIDE_SECONDS, DEFAULT_RULES, rulesFrom, resolve };
