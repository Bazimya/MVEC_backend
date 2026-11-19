// "Advertise here" on the home page: a seller (vendor) or supplier picks
// products and pays a flat fee per product (adPricePerProduct, default
// 1,000 RWF) by mobile money. Ikiguzi then approves the booking (the products
// show in the home hero for adDays, default 7) or rejects it, and the money
// goes back to the number that paid.
//
//   AWAITING_PAYMENT → PAID (waiting for Ikiguzi) → LIVE → ENDED
//                                                 → REJECTED (refunded)
//
// Money: paid → held by Ikiguzi (ESCROW_HOLDING); approved → Ikiguzi revenue
// (AD_PLACEMENT_FEE); rejected → refunded to the payer.
const AdBooking = require("../models/AdBooking");
const Product = require("../models/Product");
const Payment = require("../models/Payment");
const ledger = require("./ledger.service");
const notifications = require("./notification.service");
const platformSettings = require("./platformSettings.service");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const idOf = (v) => String(v?._id || v?.id || v || "");
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const DAY = 24 * 3600 * 1000;
const MAX_PRODUCTS = 10;
const SELLERS = ["vendor", "supplier", "super_admin"];
const LABELS = {
  AWAITING_PAYMENT: "Waiting for your payment",
  PAID: "Paid: Ikiguzi is reviewing it",
  LIVE: "Live on the home page",
  REJECTED: "Rejected: refunded",
  ENDED: "Ended",
  CANCELLED: "Cancelled",
};

async function pricing() {
  const s = await platformSettings.get();
  return { pricePerProduct: Number(s.adPricePerProduct ?? 1000), days: Number(s.adDays ?? 7), maxProducts: MAX_PRODUCTS };
}

/** Bookings whose time is up become ENDED (checked when anyone reads them). */
async function endExpired(now = new Date()) {
  await AdBooking.updateMany({ status: "LIVE", endsAt: { $lte: now } }, { $set: { status: "ENDED" } });
}

const view = (b) => {
  const r = b.toObject ? b.toObject() : b;
  return { ...r, id: idOf(r), statusLabel: LABELS[r.status] };
};

/**
 * Starts a booking for `productIds` and sends the mobile money prompt to
 * `phoneNumber`. Only accounts that list products (vendors, suppliers) may.
 */
async function create(user, { productIds = [], phoneNumber } = {}) {
  if (!SELLERS.includes(user.role)) throw httpError(403, "Only seller and supplier accounts can advertise. Open a store to advertise your products.");
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(String))];
  if (!ids.length) throw httpError(400, "Choose at least one product to advertise.");
  const price = await pricing();
  if (ids.length > price.maxProducts) throw httpError(400, `Advertise at most ${price.maxProducts} products at once.`);
  const products = await Product.find({ _id: { $in: ids }, vendor: idOf(user) }).select("name status stockQuantity media").lean();
  if (products.length !== ids.length) throw httpError(400, "You can only advertise your own products.");
  const notLive = products.find((p) => p.status !== "ACTIVE" || !(p.stockQuantity > 0));
  if (notLive) throw httpError(400, `${notLive.name} must be on sale and in stock to advertise.`);

  const amount = price.pricePerProduct * products.length;
  const booking = await AdBooking.create({
    bookingNumber: `ADB-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
    seller: idOf(user),
    sellerRole: user.role,
    products: products.map((p) => ({ id: idOf(p), name: p.name, image: p.media?.mainImage || "" })),
    pricePerProduct: price.pricePerProduct,
    amount,
    days: price.days,
    status: "AWAITING_PAYMENT",
  });
  const payments = require("../controllers/payment.controller");
  let result;
  try {
    result = await payments.initiateStandalonePayment({
      amount, phoneNumber, userId: idOf(user), gatewayService: payments.paypackGateway,
      purpose: "AD_BOOKING", reference: `ADB-${idOf(booking)}-${Date.now()}`,
    });
  } catch (error) {
    booking.status = "CANCELLED";
    await booking.save();
    throw error;
  }
  await AdBooking.updateOne({ _id: booking._id }, { $set: { payment: String(result.paymentId) } });
  const fresh = await AdBooking.findById(booking._id);
  return {
    message: fresh.status === "PAID"
      ? `Paid ${money(amount)}. Ikiguzi will review your ad and tell you when it's live.`
      : `${result.message} You pay ${money(amount)} (${products.length} × ${money(price.pricePerProduct)}).`,
    booking: view(fresh),
    paymentId: result.paymentId,
    status: result.status,
  };
}

/** The payment succeeded (payment.service.fulfilStandalonePayment): wait for Ikiguzi. */
async function markPaid(payment) {
  const bookingId = String(payment.transactionReference || "").split("-")[1];
  const booking = await AdBooking.findOne({ _id: bookingId, status: { $in: ["AWAITING_PAYMENT", "CANCELLED"] } });
  if (!booking) return null;
  booking.status = "PAID";
  booking.paidAt = new Date();
  booking.payment = idOf(payment);
  booking.payerPhone = payment.phoneNumber || "";
  await booking.save();
  await ledger.post({
    from: ["BUYER_PAYMENTS"], to: ["ESCROW_HOLDING"], amount: booking.amount, entryType: "PAYMENT_RECEIVED",
    reference: booking.bookingNumber, description: `Ad booking ${booking.bookingNumber} paid (held until Ikiguzi reviews it)`,
  }).catch((e) => console.error("Ad booking ledger:", e.message));
  notifications.adminAlert({ title: "Ad booking to approve", message: `${booking.bookingNumber}: ${booking.products.length} product(s), ${money(booking.amount)} paid.`, link: "/admin/advertising" }).catch(() => {});
  notifications.notify(booking.seller, { type: "PAYMENT", title: "Ad payment received", message: `${money(booking.amount)} received. Ikiguzi will review your ad shortly.`, link: "/advertise" }).catch(() => {});
  return booking;
}

async function mine(user) {
  await endExpired();
  const rows = await AdBooking.find({ seller: idOf(user) }).sort({ createdAt: -1 }).limit(50).lean();
  return { bookings: rows.map(view), ...(await pricing()) };
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
  const booking = await AdBooking.findById(id).catch(() => null);
  if (!booking) throw httpError(404, "Ad booking not found.");
  return booking;
}

/** Ikiguzi approves: live from now for the booked days; the fee is Ikiguzi's. */
async function approve(admin, id) {
  const booking = await load(id);
  if (booking.status !== "PAID") throw httpError(409, `This booking is ${LABELS[booking.status].toLowerCase()}.`);
  const now = new Date();
  booking.status = "LIVE";
  booking.startsAt = now;
  booking.endsAt = new Date(now.getTime() + booking.days * DAY);
  booking.reviewedBy = idOf(admin);
  booking.reviewedAt = now;
  await booking.save();
  await ledger.mvecEarned({
    from: ["ESCROW_HOLDING"], amount: booking.amount, entryType: "AD_PLACEMENT_FEE",
    reference: booking.bookingNumber, description: `Home page ad ${booking.bookingNumber}`,
  }).catch((e) => console.error("Ad booking revenue:", e.message));
  notifications.notify(booking.seller, {
    type: "SYSTEM", title: "Your ad is live",
    message: `${booking.products.map((p) => p.name).join(", ")} ${booking.products.length === 1 ? "is" : "are"} on the Ikiguzi home page until ${booking.endsAt.toLocaleDateString("en-GB")}.`,
    link: "/advertise",
  }).catch(() => {});
  return { message: "Approved: the ad is live.", booking: view(booking) };
}

/** Ikiguzi rejects: the money goes back to the number that paid. */
async function reject(admin, id, { reason = "" } = {}) {
  const booking = await load(id);
  if (booking.status !== "PAID") throw httpError(409, `This booking is ${LABELS[booking.status].toLowerCase()}.`);
  const why = String(reason || "").trim();
  if (why.length < 5) throw httpError(400, "Tell the seller why, in a few words.");
  booking.status = "REJECTED";
  booking.rejectionReason = why.slice(0, 500);
  booking.reviewedBy = idOf(admin);
  booking.reviewedAt = new Date();
  await booking.save();
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
    if (d) {
      booking.refund = idOf(d);
      await booking.save();
    }
    if (payment) await Payment.updateOne({ _id: payment._id }, { $set: { status: "REFUNDED" } });
  }
  notifications.notify(booking.seller, {
    type: "PAYMENT", title: "Your ad wasn't approved",
    message: `${why} ${money(booking.amount)} is on its way back to ${phone || "the number that paid"}.`,
    link: "/advertise",
    sms: phone ? { phone, text: `Ikiguzi: your ad wasn't approved. ${money(booking.amount)} is being refunded to this number.` } : undefined,
  }).catch(() => {});
  return { message: "Rejected. The money is being refunded to the number that paid.", booking: view(booking) };
}

/** Live booked products for the home hero: [{ id, placement, product }]. */
async function liveHeroProducts(limit = 6) {
  await endExpired();
  const live = await AdBooking.find({ status: "LIVE" }).sort({ startsAt: -1 }).limit(50).lean();
  const ids = [...new Set(live.flatMap((b) => (b.products || []).map((p) => idOf(p.id)).filter(Boolean)))];
  if (!ids.length) return [];
  const products = await Product.find({ _id: { $in: ids }, status: "ACTIVE" })
    .select("name price discountPrice dealPrice dealStartsAt dealEndsAt dealQuantity dealSold media stockQuantity status vendor category averageRating reviewCount publicId")
    .populate("vendor", "Fullname companyName")
    .populate("category", "name slug")
    .lean();
  const byId = new Map(products.map((p) => [idOf(p), p]));
  const out = [];
  for (const b of live) {
    for (const p of b.products || []) {
      const productId = idOf(p.id);
      const product = byId.get(productId);
      if (product && !out.some((o) => idOf(o.product) === productId)) {
        out.push({ id: b.bookingNumber, placement: "HOMEPAGE_HERO", product });
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { pricing, create, markPaid, mine, forAdmin, approve, reject, liveHeroProducts, LABELS };