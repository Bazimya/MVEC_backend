// "Advertise here" on the home page: a seller (vendor) or supplier buys banner
// time for one product. The price follows the seconds bought
// (utils/adPricing.js: 5,000 RWF = 3 seconds, +1,000 RWF per extra second) and
// is always worked out here, never taken from the client. The seller writes the
// banner's title and description and pays by mobile money. As soon as the
// payment is verified the ad goes LIVE (it runs for adDays, default 7, and each
// turn of the banner shows it for the seconds it paid for). Ikiguzi can pause
// it, remove it, or reject it and refund the number that paid.
//
//   AWAITING_PAYMENT → PAID → LIVE → ENDED
//                    → CANCELLED    → PAUSED ⇄ LIVE, → REMOVED
//                                   → REJECTED (refunded)
//
// An ad is only ever PAID after the payment layer verified the money with the
// gateway (payment.service: webhook or provider status check) and only ever
// shows while LIVE, inside its dates, with a successful payment behind it.
// Older flat-fee bookings (no displaySeconds) still wait in PAID for an admin
// to approve them.
//
// Money: paid → held by Ikiguzi (ESCROW_HOLDING). A new-style ad stays in
// escrow while it runs, so it can still be refunded, and becomes Ikiguzi revenue
// (AD_PLACEMENT_FEE) when it ends or is removed. An older booking became revenue
// when approved. Rejected → refunded to the payer.
const AdBooking = require("../models/AdBooking");
const Product = require("../models/Product");
const Payment = require("../models/Payment");
const orm = require("../database/orm");
const ledger = require("./ledger.service");
const notifications = require("./notification.service");
const platformSettings = require("./platformSettings.service");
const adPricing = require("../utils/adPricing");
const { formatRwandanPhone } = require("../utils/momo.util");
const { simulatedPaymentsAllowed } = require("../config/env");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const idOf = (v) => String(v?._id || v?.id || v || "");
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const DAY = 24 * 3600 * 1000;
const DEFAULT_SLIDE_SECONDS = 5; // what the banner gives an ad with no bought time (matches the website)
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const TITLE = { min: 3, max: 60 };
const DESCRIPTION = { min: 5, max: 1000 };
const SELLERS = ["vendor", "supplier", "super_admin"];
const LABELS = {
  AWAITING_PAYMENT: "Waiting for your payment",
  PAID: "Paid: going live",
  LIVE: "Live on the home page",
  REJECTED: "Rejected: refunded",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
  PAUSED: "Paused by Ikiguzi",
  REMOVED: "Removed by Ikiguzi",
};
const PAYMENT_LABELS = { PENDING: "Payment pending", SUCCESS: "Payment successful", FAILED: "Payment failed", CANCELLED: "Payment cancelled" };

async function pricing() {
  const s = await platformSettings.get();
  const rules = adPricing.rulesFrom(s);
  return {
    ...rules,
    ladder: adPricing.ladder(rules),
    days: Number(s.adDays ?? 7),
    titleMax: TITLE.max,
    descriptionMax: DESCRIPTION.max,
  };
}

/** What a seller may pay with: the standalone payments the gateway really supports (mobile money, MTN and Airtel). */
function paymentMethods() {
  const paypack = require("./paypack.service");
  const usable = !paypack.isSandbox() || simulatedPaymentsAllowed();
  const testMode = paypack.isSandbox();
  return {
    methods: [
      { id: "MOMO", provider: "MTN", label: "MTN Mobile Money", numbers: "078 or 079", available: usable, testMode },
      { id: "AIRTEL", provider: "AIRTEL", label: "Airtel Money", numbers: "072 or 073", available: usable, testMode },
    ],
  };
}

/** Quote for the seconds or amount a seller is considering. 400 for a price that isn't on the ladder. */
async function quote({ seconds, amount } = {}) {
  const p = await pricing();
  const { seconds: s, amount: a } = adPricing.resolve({ seconds, amount }, p);
  return { seconds: s, amount: a, days: p.days };
}

// New-style ads (bought by the second) earn Ikiguzi their fee when they finish;
// older flat-fee bookings already did when they were approved.
const earnsAtEnd = (b) => Boolean(b.displaySeconds);

async function postRevenue(booking) {
  await ledger.mvecEarned({
    from: ["ESCROW_HOLDING"], amount: booking.amount, entryType: "AD_PLACEMENT_FEE",
    reference: booking.bookingNumber, description: `Home page ad ${booking.bookingNumber}`,
  }).catch((e) => console.error("Ad booking revenue:", e.message));
}
const recogniseRevenue = (booking) => (earnsAtEnd(booking) ? postRevenue(booking) : null);

/** Bookings whose time is up become ENDED, and the fee becomes Ikiguzi's (checked when anyone reads them). */
async function endExpired(now = new Date()) {
  const due = await AdBooking.find({ status: { $in: ["LIVE", "PAUSED"] }, endsAt: { $lte: now } }).lean();
  for (const b of due) {
    const claimed = await AdBooking.updateOne({ _id: b._id, status: { $in: ["LIVE", "PAUSED"] } }, { $set: { status: "ENDED" } });
    if (claimed.modifiedCount) await recogniseRevenue(b);
  }
}

const view = (b) => {
  const r = b.toObject ? b.toObject() : b;
  return { ...r, id: idOf(r), statusLabel: LABELS[r.status], paymentLabel: PAYMENT_LABELS[r.paymentStatus] };
};

const cleanText = (value, { min, max, label }) => {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t]+/g, " ").trim();
  if (text.length < min) throw httpError(400, `Write a ${label} of at least ${min} characters.`);
  if (text.length > max) throw httpError(400, `Keep the ${label} to ${max} characters or fewer.`);
  return text;
};

/**
 * Starts a booking for one product and sends the mobile money prompt to
 * `phoneNumber`. Only accounts that list products (vendors, suppliers) may.
 * The seller picks seconds (or an amount); the server prices it.
 */
async function create(user, { productId, title, description, seconds, amount, phoneNumber, paymentMethod } = {}) {
  if (!SELLERS.includes(user.role)) throw httpError(403, "Only seller and supplier accounts can advertise. Open a store to advertise your products.");
  if (!orm.isValidObjectId(productId)) throw httpError(400, "Choose the product you want to advertise.");
  const cleanTitle = cleanText(title, { ...TITLE, label: "title" });
  const cleanDescription = cleanText(description, { ...DESCRIPTION, label: "description" });
  const price = await pricing();
  const bought = adPricing.resolve({ seconds, amount }, price);

  const method = paymentMethods().methods.find((m) => m.id === String(paymentMethod || "").toUpperCase());
  if (!method) throw httpError(400, "Choose how you want to pay: MTN Mobile Money or Airtel Money.");
  if (!method.available) throw httpError(503, "Mobile money payments are temporarily unavailable. Please try again later.");
  const phoneInfo = formatRwandanPhone(phoneNumber);
  if (!phoneInfo) throw httpError(400, "Enter the MTN (078/079) or Airtel (072/073) number that pays, for example 0788 123 456.");
  if (phoneInfo.provider !== method.provider) {
    throw httpError(400, `That is ${phoneInfo.provider === "MTN" ? "an MTN" : "an Airtel"} number. Use ${method.provider === "MTN" ? "an MTN" : "an Airtel"} number for ${method.label}, or choose the other payment method.`);
  }

  const product = await Product.findOne({ _id: productId, vendor: idOf(user) }).select("name status stockQuantity media").lean();
  if (!product) throw httpError(400, "You can only advertise your own products.");
  if (product.status !== "ACTIVE" || !(product.stockQuantity > 0)) throw httpError(400, `${product.name} must be on sale and in stock to advertise.`);

  // One prompt at a time: a double click must not send the seller two payment requests.
  const recent = await AdBooking.findOne({
    seller: idOf(user), product: idOf(product), status: "AWAITING_PAYMENT", createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
  });
  if (recent) throw Object.assign(httpError(409, "A payment prompt for this ad was already sent to your phone. Approve it, or wait two minutes before trying again."), { bookingId: idOf(recent) });

  const booking = await AdBooking.create({
    bookingNumber: `ADB-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
    seller: idOf(user),
    sellerRole: user.role,
    product: idOf(product),
    products: [{ id: idOf(product), name: product.name, image: product.media?.mainImage || "" }],
    title: cleanTitle,
    description: cleanDescription,
    displaySeconds: bought.seconds,
    pricePerProduct: bought.amount,
    amount: bought.amount,
    days: price.days,
    paymentMethod: method.id,
    paymentStatus: "PENDING",
    status: "AWAITING_PAYMENT",
  });
  const payments = require("../controllers/payment.controller");
  let result;
  try {
    result = await payments.initiateStandalonePayment({
      amount: bought.amount, phoneNumber, userId: idOf(user), gatewayService: payments.paypackGateway, explicitProvider: method.provider,
      purpose: "AD_BOOKING", reference: `ADB-${idOf(booking)}-${Date.now()}`,
    });
  } catch (error) {
    await AdBooking.updateOne({ _id: booking._id, status: "AWAITING_PAYMENT" }, { $set: { status: "CANCELLED", paymentStatus: "FAILED" } });
    throw error;
  }
  await AdBooking.updateOne({ _id: booking._id, payment: null }, { $set: { payment: String(result.paymentId) } });
  const fresh = await AdBooking.findById(booking._id);
  return {
    message: fresh.status === "PAID"
      ? `Paid ${money(bought.amount)}. Ikiguzi will review your ad and tell you when it's live.`
      : `${result.message} You pay ${money(bought.amount)} for ${bought.seconds} seconds in the banner.`,
    booking: view(fresh),
    paymentId: result.paymentId,
    status: result.status,
  };
}

/**
 * The payment layer saw a verified, successful payment for this booking
 * (payment.service.fulfilStandalonePayment): wait for Ikiguzi to review it.
 * Safe to call twice: only one call moves the booking to PAID.
 */
async function markPaid(payment) {
  if (!payment || payment.status !== "SUCCESS") return null; // never act on anything but a verified success
  const bookingId = String(payment.transactionReference || "").split("-")[1];
  if (!orm.isValidObjectId(bookingId)) return null;
  const found = await AdBooking.findById(bookingId);
  if (!found) return null;
  if (Number(payment.amount) !== Number(found.amount) || idOf(payment.user) !== idOf(found.seller)) {
    console.error(`Ad booking ${found.bookingNumber}: payment ${idOf(payment)} does not match the booking (amount or payer); not activated.`);
    notifications.adminAlert({ title: "Ad payment needs a look", message: `${found.bookingNumber}: payment ${money(payment.amount)} does not match the booking (${money(found.amount)}).`, link: "/admin/advertising" }).catch(() => {});
    return null;
  }
  const paidAt = new Date();
  const claimed = await AdBooking.updateOne(
    { _id: bookingId, status: { $in: ["AWAITING_PAYMENT", "CANCELLED"] } },
    { $set: { status: "PAID", paymentStatus: "SUCCESS", paidAt, payment: idOf(payment), payerPhone: payment.phoneNumber || "" } },
  );
  if (!claimed.modifiedCount) return null; // a repeated callback: already handled
  const booking = await AdBooking.findById(bookingId);
  await ledger.post({
    from: ["BUYER_PAYMENTS"], to: ["ESCROW_HOLDING"], amount: booking.amount, entryType: "PAYMENT_RECEIVED",
    reference: booking.bookingNumber, description: `Ad booking ${booking.bookingNumber} paid (held until Ikiguzi reviews it)`,
  }).catch((e) => console.error("Ad booking ledger:", e.message));
  notifications.notify(booking.seller, { type: "PAYMENT", title: "Ad payment received", message: `${money(booking.amount)} received.${booking.displaySeconds ? " Your ad is going live now." : " Ikiguzi will review your ad shortly."}`, link: "/advertise" }).catch(() => {});
  if (!booking.displaySeconds) {
    notifications.adminAlert({ title: "Ad booking to approve", message: `${booking.bookingNumber}: ${money(booking.amount)} paid.`, link: "/admin/advertising" }).catch(() => {});
    return booking;
  }
  return (await goLive(bookingId)) || (await AdBooking.findById(bookingId));
}

/** The gateway reported the payment failed: the booking is cancelled and nothing goes live. */
async function markFailed(payment) {
  const bookingId = String(payment?.transactionReference || "").split("-")[1];
  if (!orm.isValidObjectId(bookingId)) return null;
  const claimed = await AdBooking.updateOne({ _id: bookingId, status: "AWAITING_PAYMENT" }, { $set: { status: "CANCELLED", paymentStatus: "FAILED" } });
  if (!claimed.modifiedCount) return null;
  const booking = await AdBooking.findById(bookingId);
  notifications.notify(booking.seller, { type: "PAYMENT", title: "Ad payment failed", message: "The payment did not go through, so your ad was not booked. No money was taken. You can try again.", link: "/advertise" }).catch(() => {});
  return booking;
}

/** The seller gives up before paying. A payment that still arrives afterwards is never lost (markPaid takes it). */
async function cancel(user, id) {
  const booking = await load(id);
  if (idOf(booking.seller) !== idOf(user)) throw httpError(404, "Ad booking not found.");
  const claimed = await AdBooking.updateOne({ _id: booking._id, status: "AWAITING_PAYMENT" }, { $set: { status: "CANCELLED", paymentStatus: "CANCELLED" } });
  if (!claimed.modifiedCount) throw httpError(409, `This booking is ${LABELS[booking.status].toLowerCase()}, so it can't be cancelled.`);
  return { message: "Booking cancelled. If you already approved the payment on your phone, tell Ikiguzi support.", booking: view(await AdBooking.findById(booking._id)) };
}

/**
 * How the banner is using each live ad right now: its place in the rotation, how
 * many ads share the banner, the length of one full round, and the share of the
 * banner's time it gets. Same ordering and seconds the banner itself uses.
 */
async function usageFor(bookings) {
  if (!bookings.some((b) => b.status === "LIVE")) return new Map();
  const live = await liveHeroProducts(12);
  const seconds = (s) => s.displaySeconds || DEFAULT_SLIDE_SECONDS;
  const cycle = live.reduce((sum, s) => sum + seconds(s), 0);
  const out = new Map();
  for (const b of bookings.filter((x) => x.status === "LIVE")) {
    const index = live.findIndex((s) => s.id === b.bookingNumber);
    out.set(idOf(b), index === -1
      ? { showing: false } // live, but its product is off sale or out of stock
      : { showing: true, position: index + 1, liveAds: live.length, secondsPerTurn: seconds(live[index]), cycleSeconds: cycle, sharePercent: cycle ? Math.round((seconds(live[index]) / cycle) * 100) : 100 });
  }
  return out;
}

async function mine(user) {
  await endExpired();
  await activatePaid();
  const rows = await AdBooking.find({ seller: idOf(user) }).sort({ createdAt: -1 }).limit(50).lean();
  const usage = await usageFor(rows);
  const now = Date.now();
  return {
    bookings: rows.map((r) => ({
      ...view(r),
      daysLeft: r.status === "LIVE" && r.endsAt ? Math.max(0, Math.ceil((new Date(r.endsAt).getTime() - now) / DAY)) : null,
      usage: usage.get(idOf(r)) || null,
    })),
    ...(await pricing()),
  };
}

/** The banner reports what happened to an ad: shown, or one of its buttons pressed. Counts only ads that are live. */
async function track(bookingNumber, event) {
  const field = { view: "views", click: "clicks" }[event];
  if (!field || !/^ADB-[A-Z0-9-]{3,40}$/.test(String(bookingNumber || ""))) throw httpError(400, "Unknown ad event.");
  const row = await AdBooking.findOne({ bookingNumber: String(bookingNumber), status: "LIVE" }).select("_id").lean();
  if (row) await AdBooking.updateOne({ _id: row._id, status: "LIVE" }, { $inc: { [field]: 1 } });
  return { ok: true };
}

async function forAdmin({ status } = {}) {
  await endExpired();
  const rows = await AdBooking.find(status ? { status: String(status).toUpperCase() } : {}).sort({ createdAt: -1 }).limit(200).lean();
  const User = require("../models/User");
  const users = await User.find({ _id: { $in: rows.map((r) => r.seller) } }).select("Fullname companyName businessName").lean();
  const byId = new Map(users.map((u) => [idOf(u), u.businessName || u.companyName || u.Fullname]));
  return { bookings: rows.map((r) => ({ ...view(r), sellerName: byId.get(idOf(r.seller)) || "" })) };
}

async function load(id) {
  if (!orm.isValidObjectId(id)) throw httpError(404, "Ad booking not found.");
  const booking = await AdBooking.findById(id).catch(() => null);
  if (!booking) throw httpError(404, "Ad booking not found.");
  return booking;
}

const notPossible = (booking) => httpError(409, `This booking is ${LABELS[booking.status].toLowerCase()}.`);

/**
 * PAID → LIVE: runs from now for the booked days. Only a verified, paid booking
 * can go live, and only once (a conditional update, so two callers can't both do it).
 * `reviewer` is the admin who approved it, or null when it went live by itself.
 */
async function goLive(id, reviewer = null) {
  const booking = await AdBooking.findById(id);
  if (!booking) return null;
  const now = new Date();
  // The column keeps whole seconds and rounds to the nearest, so round down here:
  // the ad must never look as if it starts a moment after it was paid.
  const startsAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const claimed = await AdBooking.updateOne(
    { _id: booking._id, status: "PAID", paymentStatus: "SUCCESS" },
    { $set: { status: "LIVE", startsAt, endsAt: new Date(startsAt.getTime() + booking.days * DAY), reviewedBy: reviewer, reviewedAt: reviewer ? now : null } },
  );
  if (!claimed.modifiedCount) return null;
  const live = await AdBooking.findById(booking._id);
  if (!earnsAtEnd(live)) await postRevenue(live); // an older booking is earned when approved
  notifications.notify(live.seller, {
    type: "SYSTEM", title: "Your ad is live",
    message: `${live.title || live.products.map((p) => p.name).join(", ")} is on the Ikiguzi home page until ${live.endsAt.toLocaleDateString("en-GB")}.`,
    link: "/advertise",
  }).catch(() => {});
  return live;
}

/** Puts every paid new-style ad live. Runs when the banner is read, so a booking can never be left waiting. */
async function activatePaid() {
  const waiting = await AdBooking.find({ status: "PAID", paymentStatus: "SUCCESS", displaySeconds: { $ne: null } }).select("_id").lean();
  for (const b of waiting) await goLive(b._id).catch((e) => console.error("Ad go-live:", e.message));
}

/** Ikiguzi approves a booking that is still waiting (older flat-fee bookings, or one that did not go live by itself). */
async function approve(admin, id) {
  const booking = await load(id);
  const live = await goLive(booking._id, idOf(admin));
  if (!live) throw notPossible(booking);
  return { message: "Approved: the ad is live.", booking: view(live) };
}

/** Ikiguzi rejects: the money goes back to the number that paid. */
async function reject(admin, id, { reason = "" } = {}) {
  const booking = await load(id);
  const why = String(reason || "").trim();
  if (why.length < 5) throw httpError(400, "Tell the seller why, in a few words.");
  // A new-style ad's money is still in escrow while it runs, so it can be refunded; an older one was already counted as revenue.
  const refundable = earnsAtEnd(booking) ? ["PAID", "LIVE", "PAUSED"] : ["PAID"];
  const claimed = await AdBooking.updateOne(
    { _id: booking._id, status: { $in: refundable } },
    { $set: { status: "REJECTED", rejectionReason: why.slice(0, 500), reviewedBy: idOf(admin), reviewedAt: new Date() } },
  );
  if (!claimed.modifiedCount) throw notPossible(booking);
  await ledger.post({
    from: ["ESCROW_HOLDING"], to: ["BUYER_REFUND_HOLD"], amount: booking.amount, entryType: "BUYER_REFUND",
    reference: booking.bookingNumber, description: `Ad booking ${booking.bookingNumber} rejected: refunded`,
  }).catch((e) => console.error("Ad booking refund ledger:", e.message));
  const payment = booking.payment ? await Payment.findById(booking.payment).lean() : null;
  const phone = payment?.phoneNumber || booking.payerPhone;
  if (phone) {
    const d = await require("./disbursement.service").queue({
      kind: "REFUND", recipient: booking.seller, phone, amount: booking.amount, idempotencyKey: `ad-booking-refund:${idOf(booking)}`,
    }).catch((e) => { console.error("Ad booking refund failed to queue:", e.message); return null; });
    if (d) await AdBooking.updateOne({ _id: booking._id }, { $set: { refund: idOf(d) } });
    if (payment) await Payment.updateOne({ _id: payment._id }, { $set: { status: "REFUNDED" } });
  }
  notifications.notify(booking.seller, {
    type: "PAYMENT", title: "Your ad wasn't approved",
    message: `${why} ${money(booking.amount)} is on its way back to ${phone || "the number that paid"}.`,
    link: "/advertise",
    sms: phone ? { phone, text: `Ikiguzi: your ad wasn't approved. ${money(booking.amount)} is being refunded to this number.` } : undefined,
  }).catch(() => {});
  return { message: "Rejected. The money is being refunded to the number that paid.", booking: view(await AdBooking.findById(booking._id)) };
}

/** Ikiguzi switches a live ad off for now (it keeps its end date). */
async function deactivate(admin, id) {
  const booking = await load(id);
  const claimed = await AdBooking.updateOne({ _id: booking._id, status: "LIVE" }, { $set: { status: "PAUSED", reviewedBy: idOf(admin), reviewedAt: new Date() } });
  if (!claimed.modifiedCount) throw notPossible(booking);
  notifications.notify(booking.seller, { type: "SYSTEM", title: "Your ad was paused", message: `${booking.title || "Your ad"} is off the home page for now. Contact Ikiguzi support to ask why.`, link: "/advertise" }).catch(() => {});
  return { message: "The ad is paused: it no longer shows on the home page.", booking: view(await AdBooking.findById(booking._id)) };
}

/** Puts a paused ad back, as long as its time hasn't run out. */
async function reactivate(admin, id) {
  const booking = await load(id);
  if (booking.status === "PAUSED" && booking.endsAt && new Date(booking.endsAt) <= new Date()) {
    await AdBooking.updateOne({ _id: booking._id, status: "PAUSED" }, { $set: { status: "ENDED" } });
    throw httpError(409, "This ad's time has run out, so it can't go live again.");
  }
  const claimed = await AdBooking.updateOne({ _id: booking._id, status: "PAUSED", paymentStatus: "SUCCESS" }, { $set: { status: "LIVE", reviewedBy: idOf(admin), reviewedAt: new Date() } });
  if (!claimed.modifiedCount) throw notPossible(booking);
  return { message: "The ad is live again.", booking: view(await AdBooking.findById(booking._id)) };
}

/** Ikiguzi takes an ad down for good. The record stays; any refund is Ikiguzi's decision. */
async function remove(admin, id, { reason = "" } = {}) {
  const booking = await load(id);
  const claimed = await AdBooking.updateOne(
    { _id: booking._id, status: { $in: ["LIVE", "PAUSED", "ENDED"] } },
    { $set: { status: "REMOVED", rejectionReason: String(reason || "").trim().slice(0, 500) || null, reviewedBy: idOf(admin), reviewedAt: new Date() } },
  );
  if (!claimed.modifiedCount) throw notPossible(booking);
  if (booking.status !== "ENDED") await recogniseRevenue(booking); // it ran, so the fee is earned
  return { message: "The ad was removed.", booking: view(await AdBooking.findById(booking._id)) };
}

/**
 * Live booked ads for the home hero, newest first. Only a booking that is LIVE,
 * paid, inside its dates and whose product is still on sale shows.
 * Each item: { id, placement, product, title, description, displaySeconds }.
 * Older bookings have no title or seconds (the banner uses its own defaults).
 */
async function liveHeroProducts(limit = 6) {
  await endExpired();
  await activatePaid(); // before reading the clock: an ad that just went live must count as started
  const now = new Date();
  const live = await AdBooking.find({
    status: "LIVE", paymentStatus: "SUCCESS", startsAt: { $lte: now }, endsAt: { $gt: now },
  }).sort({ startsAt: -1 }).limit(50).lean();
  const ids = [...new Set(live.flatMap((b) => (b.products || []).map((p) => idOf(p.id)).filter(Boolean)))];
  if (!ids.length) return [];
  const products = await Product.find({ _id: { $in: ids }, status: "ACTIVE" })
    .select("name price discountPrice dealPrice dealStartsAt dealEndsAt dealQuantity dealSold media stockQuantity status vendor category averageRating reviewCount publicId")
    .populate("vendor", "Fullname companyName")
    .populate("category", "name slug")
    .lean();
  // Sizes and colours, so "Buy now" knows a product needs a choice first.
  await require("./variant.service").attach(products);
  const byId = new Map(products.map((p) => [idOf(p), p]));
  const out = [];
  for (const b of live) {
    for (const p of b.products || []) {
      const productId = idOf(p.id);
      const product = byId.get(productId);
      if (product && !out.some((o) => idOf(o.product) === productId)) {
        out.push({
          id: b.bookingNumber, placement: "HOMEPAGE_HERO", product,
          title: b.title || null, description: b.description || null, displaySeconds: b.displaySeconds || null,
        });
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = {
  pricing, paymentMethods, quote, create, markPaid, markFailed, cancel, mine, forAdmin,
  approve, reject, deactivate, reactivate, remove, track, activatePaid, liveHeroProducts, LABELS,
};
