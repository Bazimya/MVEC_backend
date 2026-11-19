// Ikiguzi riders deliver sellers' parcels, the way KitchenLink's delivery
// workers deliver kitchens' orders:
//
//   buyer pays → a delivery job per rider parcel, offered straight away to
//   the nearest approved, online riders (first to accept wins), so a rider
//   can head over while the seller prepares it (KitchenLink's early dispatch)
//   → the rider follows the seller's steps and is told when it's ready
//   → picks it up (only once ready) → heads to the buyer → confirms with the
//   buyer's code → the seller's money is released and the rider earns the fee.
//
// A rider who declines is never offered that parcel again; unanswered offers
// expire and the parcel is offered again (dispatch tick). A rider going
// offline before pickup hands the parcel back to the pool.
const orm = require("../database/orm");
const Delivery = require("../models/Delivery");
const Rider = require("../models/Rider");
const Order = require("../models/Order");
const Store = require("../models/Store");
const User = require("../models/User");
const VendorWallet = require("../models/VendorWallet");
const cfg = require("../config/delivery");
const handover = require("./handover.service");
const notifications = require("./notification.service");
const socketService = require("./socket.service");

const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });
const idOf = (v) => String(v?._id || v?.id || v || "");
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const kigaliTime = (d) => new Date(d).toLocaleTimeString("en-GB", { timeZone: "Africa/Kigali", hour: "2-digit", minute: "2-digit" });

const addressLine = (a = {}) => [a.street, a.sector, a.district || a.city].filter(Boolean).join(", ");
const withHistory = (delivery, status, note) => [...(delivery.history || []), { status, at: new Date(), note: note || cfg.LABELS[status] }];

/* ----------------------------- serializing ----------------------------- */

const SELLER_FLOW = ["CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
const SELLER_STEP_TEXT = { CONFIRMED: "confirmed the order", PROCESSING: "is preparing the parcel" };

/**
 * The parcel's whole story for the rider, from order placed to delivered:
 * [{ key, label, done, at }]. The seller's steps come from the order; ready
 * is this seller's own parcel.
 */
function progressOf(delivery, order) {
  const reached = SELLER_FLOW.indexOf(order?.orderStatus);
  const ready = Boolean(delivery.readyAt);
  const past = (step) => ready || reached >= SELLER_FLOW.indexOf(step);
  const steps = [
    { key: "PLACED", label: "Order placed", done: true, at: order?.createdAt || delivery.createdAt },
    { key: "CONFIRMED", label: "Paid and confirmed", done: Boolean(order?.paidAt) || past("CONFIRMED"), at: order?.paidAt || null },
    { key: "PROCESSING", label: "Seller preparing it", done: past("PROCESSING"), at: null },
    { key: "READY_FOR_SHIPMENT", label: "Ready for pickup", done: ready, at: delivery.readyAt || null },
    { key: "PICKED_UP", label: "Picked up", done: Boolean(delivery.pickedUpAt), at: delivery.pickedUpAt || null },
    { key: "OUT_FOR_DELIVERY", label: "On the way to the buyer", done: ["OUT_FOR_DELIVERY", "DELIVERED"].includes(delivery.status), at: null },
    { key: "DELIVERED", label: "Delivered", done: delivery.status === "DELIVERED", at: delivery.deliveredAt || null },
  ];
  // Times for steps the history recorded.
  for (const h of delivery.history || []) {
    const step = steps.find((x) => x.key === h.status && !x.at);
    if (step) step.at = h.at;
  }
  return steps;
}

/**
 * What a rider sees. Before accepting, only the pickup area and the fee: the
 * buyer's name, phone and exact address appear once the parcel is theirs.
 */
async function serialize(delivery, { rider = null, reveal = false, order = null } = {}) {
  const o = order || (await Order.findById(delivery.order).select("orderNumber recipient customer items createdAt paidAt orderStatus").lean());
  const mine = reveal && rider && idOf(delivery.rider) === idOf(rider.user);
  const ready = Boolean(delivery.readyAt);
  const items = (o?.items || []).filter((i) => idOf(i.vendor) === idOf(delivery.vendor));
  const here = rider?.lat != null ? { lat: rider.lat, lng: rider.lng } : null;
  return {
    id: idOf(delivery),
    orderId: idOf(delivery.order),
    orderNumber: o?.orderNumber || "",
    status: delivery.status,
    statusLabel: cfg.LABELS[delivery.status],
    // Collecting waits for the seller to mark the parcel ready.
    allowedNextStatuses: mine ? (cfg.RIDER_STEPS[delivery.status] || []).filter((step) => step !== "PICKED_UP" || ready) : [],
    ready,
    readyAt: delivery.readyAt || null,
    waitingForSeller: !ready && ["READY_FOR_PICKUP", "ASSIGNED"].includes(delivery.status),
    progress: progressOf(delivery, o),
    canConfirm: mine && delivery.status === "OUT_FOR_DELIVERY",
    fee: Number(delivery.fee) || 0,
    distanceKm: Number(delivery.distanceKm) || 0,
    distanceToPickupKm: here ? Math.round(cfg.haversineKm(here.lat, here.lng, delivery.pickupLat, delivery.pickupLng) * 10) / 10 : null,
    pickup: { name: delivery.pickupName, address: delivery.pickupAddress || "", lat: delivery.pickupLat, lng: delivery.pickupLng },
    dropoff: mine
      ? { address: delivery.dropAddress || "", lat: delivery.dropLat, lng: delivery.dropLng }
      : { address: (delivery.dropAddress || "").split(", ").slice(-1)[0] || "", lat: null, lng: null },
    customer: mine ? { name: o?.recipient?.name || o?.customer?.name || "Buyer", phone: o?.recipient?.phone || o?.customer?.phone || "" } : null,
    items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
    offerExpiresAt: delivery.offerExpiresAt || null,
    assignedAt: delivery.assignedAt || null,
    pickedUpAt: delivery.pickedUpAt || null,
    deliveredAt: delivery.deliveredAt || null,
    createdAt: delivery.createdAt,
    history: delivery.history || [],
  };
}

const riderAccount = (rider, user) => ({
  id: idOf(rider),
  userId: idOf(rider.user),
  name: user?.Fullname || "",
  phone: user?.phone || "",
  vehicleType: rider.vehicleType,
  plateNumber: rider.plateNumber || "",
  province: rider.province || "",
  district: rider.district || "",
  districts: areaOf(rider),
  status: rider.status,
  reviewNote: rider.reviewNote || "",
  isOnline: Boolean(rider.isOnline),
  location: rider.lat != null ? { lat: rider.lat, lng: rider.lng, at: rider.locationAt } : null,
});

/* ------------------------- creating and offering ------------------------ */

/**
 * Turns the rider parcels of `vendorIds` into delivery jobs and offers them.
 * Called when the buyer pays (`ready: false`: the seller is still preparing)
 * and when a seller marks its part ready (a job made at payment becomes ready).
 */
async function createForOrder(order, vendorIds, { ready = true } = {}) {
  const created = [];
  const drop = order.shippingAddress?.lat != null ? { lat: order.shippingAddress.lat, lng: order.shippingAddress.lng } : null;
  for (const parcel of order.shippingBreakdown || []) {
    if (parcel.method !== "RIDER" || !vendorIds.includes(idOf(parcel.vendor)) || !drop) continue;
    const existing = await Delivery.findOne({ order: order._id, vendor: idOf(parcel.vendor), status: { $ne: "CANCELLED" } });
    if (existing) {
      if (ready && !existing.readyAt) await markReady(existing);
      continue;
    }
    const store = parcel.store ? await Store.findById(parcel.store).lean() : null;
    if (store?.pickupLat == null) continue;
    const { km } = cfg.quote({ lat: store.pickupLat, lng: store.pickupLng }, drop);
    const delivery = await Delivery.create({
      order: order._id,
      vendor: idOf(parcel.vendor),
      store: idOf(store),
      pickupLat: store.pickupLat,
      pickupLng: store.pickupLng,
      pickupName: store.storeName,
      pickupAddress: store.businessAddress || store.address?.street || "",
      dropLat: drop.lat,
      dropLng: drop.lng,
      dropAddress: addressLine(order.shippingAddress),
      distanceKm: km,
      fee: Number(parcel.fee) || 0,
      readyAt: ready ? new Date() : null,
      history: [ready
        ? { status: "READY_FOR_SHIPMENT", at: new Date(), note: "Ready at the store" }
        : { status: "READY_FOR_PICKUP", at: new Date(), note: "Order paid: offered to riders while the seller prepares it" }],
    });
    created.push(delivery);
    await dispatch(delivery._id);
  }
  return created;
}

/** The buyer paid: every rider parcel is offered now, before the seller has it ready. */
async function orderPaid(order) {
  await nudgePinless(order).catch(() => {});
  const vendorIds = (order.shippingBreakdown || []).filter((p) => p.method === "RIDER" && p.vendor).map((p) => idOf(p.vendor));
  if (!vendorIds.length) return [];
  return createForOrder(order, vendorIds, { ready: false });
}

/**
 * The seller marked the parcel ready. The rider who accepted early is told to
 * collect it, and their pickup time counts from now; with no rider yet, the
 * offer goes out again (riders who came into range meanwhile included).
 */
async function markReady(delivery) {
  const now = new Date();
  delivery.readyAt = now;
  delivery.history = withHistory(delivery, "READY_FOR_SHIPMENT", "The seller marked the parcel ready");
  await delivery.save();
  if (delivery.rider && delivery.status === "ASSIGNED") {
    const due = new Date(now.getTime() + cfg.settings().pickupMinutes * 60 * 1000);
    notifications.notify(delivery.rider, {
      type: "DELIVERY",
      title: "Parcel ready: collect it now",
      message: `${delivery.pickupName} has your parcel ready. Collect it by ${kigaliTime(due)}.`,
      link: "/delivery/trip",
      sms: `Ikiguzi: your parcel at ${delivery.pickupName} is ready. Collect it by ${kigaliTime(due)}.`,
    }).catch(() => {});
  } else if (!delivery.rider) {
    await dispatch(delivery._id);
  }
  return delivery;
}

/** A seller moved the order on: riders holding its parcels hear about it. */
async function sellerStepped(order, vendorIds, step) {
  const text = SELLER_STEP_TEXT[step];
  if (!text) return 0;
  const held = await Delivery.find({ order: order._id, vendor: { $in: vendorIds.map(String) }, status: "ASSIGNED", rider: { $ne: null } });
  for (const delivery of held) {
    if (delivery.readyAt) continue;
    delivery.history = withHistory(delivery, step, `The seller ${text}`);
    await delivery.save();
    notifications.notify(delivery.rider, {
      type: "DELIVERY",
      title: `${delivery.pickupName} ${text}`,
      message: "You'll get a message the moment the parcel is ready to collect.",
      link: "/delivery/trip",
    }).catch(() => {});
  }
  return held.length;
}

/** Riders who may be offered a job at `pickup` right now, nearest first. */
async function nearbyRiders(pickup, exclude) {
  const s = cfg.settings();
  const since = new Date(Date.now() - s.locationMaxAgeMinutes * 60 * 1000);
  const busy = new Set((await Delivery.find({ status: { $in: cfg.ACTIVE } }).select("rider").lean()).map((d) => idOf(d.rider)));
  const online = await Rider.find({ status: "APPROVED", isOnline: true, locationAt: { $gte: since } }).lean();
  return online
    .filter((r) => !exclude.has(idOf(r.user)) && !busy.has(idOf(r.user)))
    .map((r) => ({ rider: r, km: cfg.haversineKm(r.lat, r.lng, pickup.lat, pickup.lng) }))
    .filter((c) => c.km <= s.radiusKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, s.maxOfferRecipients);
}

/** Offers an unassigned parcel to riders not yet asked. */
async function dispatch(deliveryId) {
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery || delivery.rider || delivery.status !== "READY_FOR_PICKUP") return [];
  const s = cfg.settings();
  const asked = new Set([...(delivery.offers || []).map((o) => idOf(o.rider)), ...(delivery.rejectedBy || []).map(String)]);
  const candidates = await nearbyRiders({ lat: delivery.pickupLat, lng: delivery.pickupLng }, asked);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + s.offerTimeoutSeconds * 1000);
  delivery.offers = [
    ...(delivery.offers || []),
    ...candidates.map((c) => ({ rider: idOf(c.rider.user), offeredAt: now, expiresAt, response: "OFFERED" })),
  ];
  delivery.offerExpiresAt = expiresAt;
  await delivery.save();
  for (const c of candidates) {
    notifications.notify(c.rider.user, {
      type: "DELIVERY",
      title: `New delivery: ${money(delivery.fee)}`,
      message: `Pick up at ${delivery.pickupName}, ${Math.round(c.km * 10) / 10} km from you${delivery.readyAt ? "" : " (the seller is still preparing it)"}. Answer within ${s.offerTimeoutSeconds} seconds.`,
      link: `/delivery/offers/${idOf(delivery)}`,
      sms: `Ikiguzi: new delivery at ${delivery.pickupName} (${money(delivery.fee)}). Open the app to accept.`,
    }).catch(() => {});
  }
  await wakeRiders(delivery, new Set([...asked, ...candidates.map((c) => idOf(c.rider.user))]), { widen: !candidates.length && !asked.size }).catch((e) => console.error("[Delivery wake] failed:", e.message));
  return candidates.map((c) => idOf(c.rider.user));
}

/**
 * Riders who can't be offered the parcel by position yet but are probably
 * close: last seen within range (an old position, or offline), or working the
 * store's district (from its address, or looked up from its pin). With
 * `widen` (nobody in range), riders last seen up to twice the range count too.
 * Each is woken once per parcel and may then take it.
 */
async function wakeRiders(delivery, skip, { widen = false } = {}) {
  const s = cfg.settings();
  const already = new Set((delivery.alerted || []).map(String));
  const busy = new Set((await Delivery.find({ status: { $in: cfg.ACTIVE } }).select("rider").lean()).map((d) => idOf(d.rider)));
  const store = delivery.store ? await Store.findById(delivery.store).select("address businessAddress").lean() : null;
  const pinDistrict = await require("./geocode.service").districtOf(delivery.pickupLat, delivery.pickupLng).catch(() => null);
  const place = [pinDistrict, store?.address?.city, store?.businessAddress, delivery.pickupAddress].filter(Boolean).join(" ").toLowerCase();
  const reach = s.radiusKm * (widen ? 2 : 1);
  const riders = await Rider.find({ status: "APPROVED" }).lean();
  const woken = riders
    .filter((r) => { const id = idOf(r.user); return !skip.has(id) && !already.has(id) && !busy.has(id); })
    .map((r) => ({ r, km: r.lat != null ? cfg.haversineKm(r.lat, r.lng, delivery.pickupLat, delivery.pickupLng) : null }))
    .filter(({ r, km }) => (km != null && km <= reach) || areaOf(r).some((d) => place.includes(String(d).toLowerCase())))
    .slice(0, s.maxOfferRecipients);
  if (!woken.length) return [];
  await Delivery.updateOne({ _id: idOf(delivery) }, { $set: { alerted: [...already, ...woken.map(({ r }) => idOf(r.user))] } });
  for (const { r } of woken) {
    const ask = r.isOnline ? "Open Ikiguzi to see it and accept." : "Go online in Ikiguzi to take it.";
    notifications.notify(r.user, {
      type: "DELIVERY",
      title: `A parcel is waiting near you: ${money(delivery.fee)}`,
      message: `Pick up at ${delivery.pickupName}. ${ask}`,
      link: `/delivery/offers/${idOf(delivery)}`,
      sms: `Ikiguzi: a parcel is waiting at ${delivery.pickupName} (${money(delivery.fee)}). ${ask}`,
    }).catch(() => {});
  }
  return woken.map(({ r }) => idOf(r.user));
}

/** Offers whose time ran out go to the next riders (and to riders who came online). */
async function expireStaleOffers() {
  const stale = await Delivery.find({ status: "READY_FOR_PICKUP", rider: null, offerExpiresAt: { $lte: new Date() } }).select("_id").lean();
  for (const d of stale) await dispatch(d._id);
  return stale.length;
}

/* ------------------------------- the rider ------------------------------ */

async function riderOf(user) {
  const rider = await Rider.findOne({ user: idOf(user) });
  if (!rider) throw httpError(404, "Finish signing up as a rider first.", "RIDER_NOT_FOUND");
  return rider;
}

/** A rider must be approved (and not suspended) to see or take jobs. */
async function approvedRider(user) {
  const rider = await riderOf(user);
  if (rider.status !== "APPROVED") {
    throw httpError(403, {
      PENDING: "Your rider account is waiting for Ikiguzi's approval. You'll get a message once you can take deliveries.",
      REJECTED: `Your rider application was not approved${rider.reviewNote ? `: ${rider.reviewNote}` : "."}`,
      SUSPENDED: "Your rider account is suspended. Contact Ikiguzi support.",
    }[rider.status], `RIDER_${rider.status}`);
  }
  return rider;
}

async function profile(user) {
  const rider = await riderOf(user);
  return { rider: riderAccount(rider, await User.findById(idOf(user)).select("Fullname phone").lean()) };
}

/** { province, district } from one of Rwanda's 30 districts; {} when none is given. */
/**
 * The districts a rider delivers in, from `{ districts: [...] }` or the older
 * `{ district }`: { districts, district, province } (the first one leads).
 */
function readArea(body = {}, { required = false } = {}) {
  const { DISTRICTS, provinceOfDistrict } = require("../config/rwandaLocations");
  const raw = Array.isArray(body.districts) ? body.districts : body.district ? [body.district] : [];
  const wanted = [...new Set(raw.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) {
    if (required) throw httpError(400, "Choose at least one district you deliver in.");
    return {};
  }
  const districts = wanted.map((w) => DISTRICTS.find((d) => d.toLowerCase() === w));
  if (districts.some((d) => !d)) throw httpError(400, "Choose from Rwanda's districts.");
  return { districts, district: districts[0], province: provinceOfDistrict(districts[0]) };
}

const areaOf = (rider) => (rider.districts?.length ? rider.districts : rider.district ? [rider.district] : []);

/** The rider changes the districts they work in. { districts } or { district } */
async function setArea(user, body = {}) {
  const rider = await riderOf(user);
  Object.assign(rider, readArea(body, { required: true }));
  await rider.save();
  return { message: `You now deliver in ${rider.districts.join(", ")}.`, rider: riderAccount(rider, await User.findById(idOf(user)).select("Fullname phone").lean()) };
}

async function register(user, body = {}) {
  if (await Rider.findOne({ user: idOf(user) }).lean()) throw httpError(409, "You're already signed up as a rider.");
  const vehicleType = String(body.vehicleType || "MOTORBIKE").toUpperCase();
  if (!["MOTORBIKE", "BICYCLE", "CAR", "ON_FOOT"].includes(vehicleType)) throw httpError(400, "Choose motorbike, bicycle, car or on foot.");
  const plateNumber = String(body.plateNumber || "").trim().toUpperCase().slice(0, 20);
  // Riders signing themselves up give their plate; an admin adding a rider vouches for them.
  if (!body.approved && ["MOTORBIKE", "CAR"].includes(vehicleType) && plateNumber.length < 4) throw httpError(400, "Enter your plate number.");
  // The district they work in (the sign-up forms ask for it; older apps don't send it).
  const area = readArea(body);
  const rider = await Rider.create({ user: idOf(user), vehicleType, plateNumber: plateNumber || undefined, ...area, status: body.approved ? "APPROVED" : "PENDING" });
  if (!body.approved) {
    notifications.adminAlert({ title: "New rider to approve", message: "A rider signed up and is waiting for approval.", link: "/admin/riders" }).catch(() => {});
  }
  return rider;
}

/** A reading from the phone's GPS, or null when it's missing or out of range. */
const reading = (value, min, max) => {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) || n < min || n > max ? null : n;
};

async function updateLocation(user, body = {}) {
  const rider = await riderOf(user);
  const point = cfg.readPin(body, { required: true, label: "your location" });
  rider.lat = point.lat;
  rider.lng = point.lng;
  rider.heading = reading(body.heading, 0, 360);
  rider.speedMps = reading(body.speedMps ?? body.speed, 0, 70);
  rider.accuracyM = reading(body.accuracyM ?? body.accuracy, 0, 10000);
  rider.locationAt = new Date();
  await rider.save();
  return { location: { lat: point.lat, lng: point.lng, at: rider.locationAt } };
}

/**
 * Takes a parcel back from the rider who accepted it (before pickup) and
 * offers it to other riders; never back to that rider.
 */
async function handBack(delivery, note) {
  const riderId = idOf(delivery.rider);
  delivery.rider = null;
  delivery.status = "READY_FOR_PICKUP";
  delivery.assignedAt = null;
  delivery.pickupWarnedAt = null;
  delivery.lateAt = null;
  delivery.offerExpiresAt = null;
  delivery.rejectedBy = [...new Set([...(delivery.rejectedBy || []).map(String), riderId])];
  delivery.history = withHistory(delivery, "READY_FOR_PICKUP", note);
  await delivery.save();
  await dispatch(delivery._id);
  return riderId;
}

/** Going offline hands parcels not yet picked up back to the pool. */
async function setAvailability(user, body = {}) {
  const rider = await approvedRider(user);
  rider.isOnline = body.isOnline === undefined ? !rider.isOnline : Boolean(body.isOnline);
  await rider.save();
  let handedBack = 0;
  if (!rider.isOnline) {
    const assigned = await Delivery.find({ rider: idOf(user), status: "ASSIGNED" });
    for (const delivery of assigned) {
      await handBack(delivery, "The rider went offline; offered to others");
      handedBack += 1;
    }
  }
  return { rider: riderAccount(rider, await User.findById(idOf(user)).select("Fullname phone").lean()), handedBack };
}

const wasOffered = (delivery, userId) =>
  (delivery.offers || []).some((o) => idOf(o.rider) === userId) || (delivery.alerted || []).map(String).includes(userId);

/** Jobs this rider may take: offered to them, or open and within range now. */
async function listAvailable(user) {
  const rider = await approvedRider(user);
  if (!rider.isOnline) return { deliveries: [], online: false, radiusKm: cfg.settings().radiusKm };
  const me = idOf(user);
  const { radiusKm } = cfg.settings();
  const open = await Delivery.find({ status: "READY_FOR_PICKUP", rider: null }).lean();
  const near = open
    .filter((d) => !(d.rejectedBy || []).map(String).includes(me))
    .map((d) => ({ d, km: rider.lat != null ? cfg.haversineKm(rider.lat, rider.lng, d.pickupLat, d.pickupLng) : null }))
    .filter(({ d, km }) => wasOffered(d, me) || (km != null && km <= radiusKm))
    .sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  return { deliveries: await Promise.all(near.map(({ d }) => serialize(d, { rider }))), online: true, radiusKm };
}

async function active(user) {
  const rider = await riderOf(user);
  const delivery = await Delivery.findOne({ rider: idOf(user), status: { $in: cfg.ACTIVE } }).sort({ assignedAt: -1 }).lean();
  return { delivery: delivery ? await serialize(delivery, { rider, reveal: true }) : null };
}

/** One parcel, for the rider who opened its notification. */
async function offerFor(user, deliveryId) {
  const rider = await riderOf(user);
  const me = idOf(user);
  const delivery = await Delivery.findById(deliveryId).lean();
  if (!delivery) throw httpError(404, "This delivery no longer exists.");
  if (idOf(delivery.rider) === me) {
    return { delivery: await serialize(delivery, { rider, reveal: true }), mine: true, canTake: false, online: Boolean(rider.isOnline) };
  }
  if (delivery.status === "CANCELLED") throw httpError(410, "The buyer's order was cancelled, so this parcel isn't needed.", "OFFER_GONE");
  if (delivery.rider || delivery.status !== "READY_FOR_PICKUP") throw httpError(410, "Another rider already took this parcel.", "OFFER_GONE");
  if ((delivery.rejectedBy || []).map(String).includes(me)) throw httpError(410, "You turned this parcel down.", "OFFER_GONE");
  const km = rider.lat != null ? cfg.haversineKm(rider.lat, rider.lng, delivery.pickupLat, delivery.pickupLng) : null;
  const canTake = rider.status === "APPROVED" && (wasOffered(delivery, me) || (km != null && km <= cfg.settings().radiusKm));
  return { delivery: await serialize(delivery, { rider }), mine: false, canTake, online: Boolean(rider.isOnline) };
}

async function accept(user, deliveryId) {
  const rider = await approvedRider(user);
  if (!rider.isOnline) throw httpError(409, "Go online to take deliveries.");
  const me = idOf(user);
  if (await Delivery.findOne({ rider: me, status: { $in: cfg.ACTIVE } }).lean()) {
    throw httpError(409, "Finish your current delivery first.", "RIDER_BUSY");
  }
  const current = await Delivery.findById(deliveryId).lean();
  if (!current) throw httpError(404, "This delivery no longer exists.");
  const km = rider.lat != null ? cfg.haversineKm(rider.lat, rider.lng, current.pickupLat, current.pickupLng) : null;
  if (!wasOffered(current, me) && !(km != null && km <= cfg.settings().radiusKm)) {
    throw httpError(403, `This parcel is more than ${cfg.settings().radiusKm} km from you. Only nearby riders can take it.`, "DELIVERY_OUT_OF_RANGE");
  }
  const now = new Date();
  // First to accept wins: the update only applies while nobody has it.
  const claimed = await Delivery.updateOne(
    { _id: current._id, rider: null, status: "READY_FOR_PICKUP" },
    { $set: { rider: me, status: "ASSIGNED", assignedAt: now, pickupWarnedAt: null, lateAt: null } },
  );
  if (!claimed.modifiedCount) throw httpError(409, "Another rider already took this delivery.", "DELIVERY_ALREADY_ASSIGNED");

  const delivery = await Delivery.findById(current._id);
  delivery.offers = (delivery.offers || []).map((o) => ({ ...o, response: idOf(o.rider) === me ? "ACCEPTED" : o.response === "OFFERED" ? "EXPIRED" : o.response }));
  delivery.history = withHistory(delivery, "ASSIGNED", "A rider is heading to the store");
  await delivery.save();

  const name = (await User.findById(me).select("Fullname").lean())?.Fullname || "A rider";
  notifications.notify(delivery.vendor, {
    type: "DELIVERY", title: `${name} is coming for your parcel`, message: "Have the parcel ready for the Ikiguzi rider.", link: "/vendor/orders",
  }).catch(() => {});
  const due = new Date(now.getTime() + cfg.settings().pickupMinutes * 60 * 1000);
  const away = km != null ? ` (${Math.round(km * 10) / 10} km away)` : "";
  return {
    delivery: await serialize(delivery, { rider, reveal: true }),
    message: delivery.readyAt
      ? `Head to ${delivery.pickupName}${away} and collect it by ${kigaliTime(due)}.`
      : `${delivery.pickupName}${away} is still preparing the parcel. You'll get a message the moment it's ready to collect.`,
  };
}

async function reject(user, deliveryId) {
  await approvedRider(user);
  const me = idOf(user);
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery) throw httpError(404, "This delivery no longer exists.");
  if (delivery.rider && idOf(delivery.rider) !== me) throw httpError(409, "Another rider already took this delivery.");
  if (idOf(delivery.rider) === me) throw httpError(409, "You already accepted this delivery. Go offline to hand it back before pickup.");
  delivery.rejectedBy = [...new Set([...(delivery.rejectedBy || []).map(String), me])];
  delivery.offers = (delivery.offers || []).map((o) => (idOf(o.rider) === me ? { ...o, response: "DECLINED" } : o));
  await delivery.save();
  await dispatch(delivery._id);
  return { declined: true };
}

/** The rider can't come after all: before pickup, they hand the parcel back to other riders. */
async function release(user, deliveryId) {
  await approvedRider(user);
  const delivery = await Delivery.findOne({ _id: deliveryId, rider: idOf(user) });
  if (!delivery) throw httpError(404, "This delivery isn't assigned to you.");
  if (delivery.status !== "ASSIGNED") throw httpError(409, "You already collected this parcel. Deliver it and confirm with the buyer's code.");
  await handBack(delivery, "The rider handed it back; offered to others");
  notifications.notify(delivery.vendor, {
    type: "DELIVERY", title: "A new rider is being found",
    message: "The rider can't come after all. Ikiguzi is offering your parcel to other riders.", link: "/vendor/orders",
  }).catch(() => {});
  return { released: true };
}

/** picked_up, then out for delivery: each step only from the one before it. */
async function updateStatus(user, deliveryId, body = {}) {
  const rider = await approvedRider(user);
  const delivery = await Delivery.findOne({ _id: deliveryId, rider: idOf(user) });
  if (!delivery) throw httpError(404, "This delivery isn't assigned to you.");
  const next = String(body.status || "").toUpperCase();
  if (!(cfg.RIDER_STEPS[delivery.status] || []).includes(next)) {
    throw httpError(409, `This delivery is ${cfg.LABELS[delivery.status].toLowerCase()}; that step isn't possible now.`, "INVALID_STEP");
  }
  if (next === "PICKED_UP" && !delivery.readyAt) {
    throw httpError(409, "The seller hasn't marked this parcel ready yet. Wait nearby: you'll get a message the moment it is.", "PARCEL_NOT_READY");
  }
  const now = new Date();
  delivery.status = next;
  if (next === "PICKED_UP") delivery.pickedUpAt = now;
  delivery.history = withHistory(delivery, next);
  await delivery.save();

  // The order follows its parcels: shipped once one is collected, out for
  // delivery once one is on its way (sellers can't move rider parcels).
  const order = await Order.findById(delivery.order);
  const orderStep = next === "PICKED_UP" ? "SHIPPED" : "OUT_FOR_DELIVERY";
  const flow = ["CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY"];
  if (order && flow.indexOf(order.orderStatus) < flow.indexOf(orderStep)) {
    order.orderStatus = orderStep;
    if (!order.shippedAt) order.shippedAt = now;
    await order.save();
    socketService.emitOrderStatusUpdate(order);
  }
  if (order && next === "OUT_FOR_DELIVERY") {
    notifications.notify(order.user, {
      type: "DELIVERY",
      title: `Your parcel from ${delivery.pickupName} is on its way`,
      message: "Give the rider your 6-digit delivery code only when you have the parcel in hand.",
      link: `/orders/${idOf(order)}`,
      sms: { phone: order.recipient?.phone, text: `Ikiguzi: your parcel from ${delivery.pickupName} is on its way. Give the rider your delivery code only when you have it.` },
    }).catch(() => {});
  }
  return { delivery: await serialize(delivery, { rider, reveal: true, order }) };
}

/** The buyer's 6-digit code (and an optional photo) completes the parcel. */
async function confirm(user, deliveryId, body = {}) {
  const rider = await approvedRider(user);
  const me = idOf(user);
  const delivery = await Delivery.findOne({ _id: deliveryId, rider: me });
  if (!delivery) throw httpError(404, "This delivery isn't assigned to you.");
  if (delivery.status !== "OUT_FOR_DELIVERY") {
    throw httpError(409, delivery.status === "DELIVERED" ? "This delivery is already confirmed." : "Start the delivery before confirming it.");
  }
  const { codeMaxAttempts } = cfg.settings();
  // Each try is counted atomically, so the code can't be guessed.
  const counted = await Delivery.updateOne({ _id: delivery._id, codeAttempts: { $lt: codeMaxAttempts } }, { $inc: { codeAttempts: 1 } });
  if (!counted.modifiedCount) throw httpError(423, "Too many wrong codes. Ikiguzi support must confirm this delivery.", "DELIVERY_CODE_LOCKED");

  const session = await orm.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(delivery.order).session(session);
    const code = String(body.code || "").trim();
    if (!order?.deliveryOtp || code !== order.deliveryOtp) {
      await session.abortTransaction();
      const left = codeMaxAttempts - (delivery.codeAttempts || 0) - 1;
      throw httpError(400, left > 0 ? `Wrong delivery code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Wrong delivery code. This delivery is now locked for Ikiguzi support.", "CODE_INVALID");
    }
    if (order.paymentStatus !== "PAID" && order.paymentMethod !== "CASH_ON_DELIVERY") {
      await session.abortTransaction();
      throw httpError(409, "This order isn't paid, so it can't be delivered.");
    }
    const vendorId = idOf(delivery.vendor);
    const { complete } = await handover.handOver({ order, vendorIds: [vendorId], riders: { [vendorId]: me }, session });
    delivery.status = "DELIVERED";
    delivery.deliveredAt = new Date();
    if (body.proofPhotoUrl) delivery.proofPhotoUrl = String(body.proofPhotoUrl).slice(0, 500);
    delivery.history = withHistory(delivery, "DELIVERED", "Confirmed with the buyer's code");
    await delivery.save({ session });
    await session.commitTransaction();

    socketService.emitOrderStatusUpdate(order);
    notifications.orderDelivered(order, { complete, vendorIds: [vendorId] }).catch(() => {});
    return { delivery: await serialize(delivery, { rider, reveal: true, order }), earned: Number(delivery.fee) || 0 };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

async function history(user, { page = 1, limit = 20 } = {}) {
  const rider = await riderOf(user);
  const size = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const filter = { rider: idOf(user), status: "DELIVERED" };
  const [rows, total] = await Promise.all([
    Delivery.find(filter).sort({ deliveredAt: -1 }).skip(skip).limit(size).lean(),
    Delivery.countDocuments(filter),
  ]);
  return { deliveries: await Promise.all(rows.map((d) => serialize(d, { rider, reveal: true }))), total, page: Number(page) || 1 };
}

/** Today's and all-time deliveries and earnings (Kigali day). */
async function stats(user) {
  const rider = await riderOf(user);
  const done = await Delivery.find({ rider: idOf(user), status: "DELIVERED" }).select("fee deliveredAt").lean();
  const kigaliDay = (d) => new Date(new Date(d).getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
  const today = kigaliDay(new Date());
  const todays = done.filter((d) => kigaliDay(d.deliveredAt) === today);
  const sum = (rows) => rows.reduce((n, d) => n + (Number(d.fee) || 0), 0);
  return {
    isOnline: Boolean(rider.isOnline),
    status: rider.status,
    todayDeliveries: todays.length,
    todayEarnings: sum(todays),
    totalDeliveries: done.length,
    totalEarnings: sum(done),
  };
}

/** Money earned from delivered parcels, and what can be withdrawn now. */
async function wallet(user) {
  await riderOf(user);
  const w = (await VendorWallet.findOne({ vendor: idOf(user) }).lean()) || {};
  return {
    wallet: {
      available: Number(w.availableBalance) || 0,
      totalEarned: Number(w.totalEarned) || 0,
      totalWithdrawn: Number(w.totalWithdrawn) || 0,
      minimumWithdrawal: 1000,
    },
  };
}

/* ----------------------------- late pickups ----------------------------- */

/**
 * Parcels accepted but not collected (every minute, as in KitchenLink): the
 * rider is reminded shortly before the deadline, flagged at it (rider and
 * admins are told), and the parcel goes to another rider a while after it.
 */
async function checkLatePickups(now = new Date()) {
  const s = cfg.settings();
  const minutes = (n) => n * 60 * 1000;
  const counts = { warned: 0, flagged: 0, reassigned: 0 };
  const waitingPickup = await Delivery.find({ status: "ASSIGNED", rider: { $ne: null } });
  for (const delivery of waitingPickup) {
    // The pickup time counts from when the rider accepted, or from when the
    // parcel became ready if they accepted while the seller was preparing it.
    if (!delivery.assignedAt || !delivery.readyAt) continue;
    const from = Math.max(new Date(delivery.assignedAt).getTime(), new Date(delivery.readyAt).getTime());
    const dueAt = new Date(from + minutes(s.pickupMinutes));
    const reassignAt = new Date(dueAt.getTime() + minutes(s.reassignAfterMinutes));
    const riderId = idOf(delivery.rider);
    if (now >= reassignAt) {
      await handBack(delivery, `Not collected by ${kigaliTime(dueAt)}; offered to other riders`);
      notifications.notify(riderId, {
        type: "DELIVERY", title: "Delivery given to another rider",
        message: `You didn't collect the parcel at ${delivery.pickupName} in time, so it went to another rider.`,
        link: "/delivery", sms: `Ikiguzi: you didn't collect the parcel at ${delivery.pickupName} in time. It went to another rider.`,
      }).catch(() => {});
      notifications.notify(delivery.vendor, {
        type: "DELIVERY", title: "A new rider is being found",
        message: "The rider didn't come in time. Ikiguzi is offering your parcel to other riders.", link: "/vendor/orders",
      }).catch(() => {});
      counts.reassigned += 1;
    } else if (now >= dueAt && !delivery.lateAt) {
      delivery.lateAt = now;
      delivery.history = withHistory(delivery, "ASSIGNED", `Not collected by ${kigaliTime(dueAt)}: late pickup`);
      await delivery.save();
      notifications.notify(riderId, {
        type: "DELIVERY", title: "Late pickup",
        message: `Collect the parcel at ${delivery.pickupName} now. At ${kigaliTime(reassignAt)} it goes to another rider.`,
        link: "/delivery/trip", sms: `Ikiguzi: collect the parcel at ${delivery.pickupName} now. At ${kigaliTime(reassignAt)} it goes to another rider.`,
      }).catch(() => {});
      notifications.adminAlert({
        title: "Late pickup",
        message: `A rider hasn't collected a parcel at ${delivery.pickupName}. It is re-offered at ${kigaliTime(reassignAt)}, or hand it back now.`,
        link: "/admin/deliveries",
      }).catch(() => {});
      counts.flagged += 1;
    } else if (now >= new Date(dueAt.getTime() - minutes(s.pickupWarnMinutes)) && !delivery.pickupWarnedAt && !delivery.lateAt) {
      delivery.pickupWarnedAt = now;
      await delivery.save();
      const left = Math.max(1, Math.ceil((dueAt - now) / 60000));
      notifications.notify(riderId, {
        type: "DELIVERY", title: `${left} minute${left === 1 ? "" : "s"} left to collect`,
        message: `Collect the parcel at ${delivery.pickupName} by ${kigaliTime(dueAt)}.`,
        link: "/delivery/trip", sms: `Ikiguzi: collect the parcel at ${delivery.pickupName} by ${kigaliTime(dueAt)}.`,
      }).catch(() => {});
      counts.warned += 1;
    }
  }
  return counts;
}

/** Admin: takes a parcel back from a rider who hasn't collected it and offers it to others. */
async function adminRelease(deliveryId, { note } = {}) {
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery) throw httpError(404, "This delivery no longer exists.");
  if (delivery.status !== "ASSIGNED") {
    throw httpError(409, delivery.status === "READY_FOR_PICKUP" ? "No rider has this parcel yet." : "The rider already collected this parcel; it can't be handed to someone else now.");
  }
  const reason = String(note || "").trim().slice(0, 200);
  const riderId = await handBack(delivery, `Ikiguzi gave the parcel to another rider${reason ? `: ${reason}` : ""}`);
  notifications.notify(riderId, {
    type: "DELIVERY", title: "Delivery given to another rider",
    message: `Ikiguzi gave the parcel at ${delivery.pickupName} to another rider${reason ? `: ${reason}` : "."} Don't collect it.`,
    link: "/delivery", sms: `Ikiguzi: the parcel at ${delivery.pickupName} went to another rider. Don't collect it.`,
  }).catch(() => {});
  return { released: true };
}

/* -------------------------------- sellers ------------------------------- */

/** Parcels of an order cancelled before delivery are withdrawn from riders. */
async function cancelForOrder(orderId) {
  const open = await Delivery.find({ order: orderId, status: { $in: ["READY_FOR_PICKUP", ...cfg.ACTIVE] } });
  for (const delivery of open) {
    if (delivery.rider) {
      notifications.notify(delivery.rider, { type: "DELIVERY", title: "Delivery cancelled", message: `The order for ${delivery.pickupName} was cancelled. Don't collect it.`, link: "/delivery" }).catch(() => {});
    }
    delivery.status = "CANCELLED";
    delivery.history = withHistory(delivery, "CANCELLED", "The order was cancelled");
    await delivery.save();
  }
}

/**
 * Parcels no rider took within `sellerFallbackMinutes`: the seller hears it
 * once and may deliver the parcel itself. Ikiguzi keeps offering it meanwhile.
 */
async function checkUnclaimed(now = new Date()) {
  const before = new Date(now.getTime() - cfg.settings().sellerFallbackMinutes * 60 * 1000);
  const waiting = await Delivery.find({ status: "READY_FOR_PICKUP", rider: null, sellerAlertedAt: null, createdAt: { $lte: before } });
  for (const delivery of waiting) {
    delivery.sellerAlertedAt = now;
    await delivery.save();
    notifications.notify(delivery.vendor, {
      type: "DELIVERY",
      title: "No rider has taken your parcel yet",
      message: "Ikiguzi keeps offering it to riders. If you'd rather not wait, deliver it yourself from the order: the delivery fee then goes to you.",
      link: `/vendor/orders/${idOf(delivery.order)}`,
    }).catch(() => {});
  }
  return waiting.length;
}

/**
 * The seller delivers a parcel no rider has taken: the rider job is withdrawn
 * and the parcel becomes the seller's own delivery (its fee goes to the seller
 * at hand-over, which the buyer's code confirms as usual).
 */
async function sellerDelivers(vendorIds, orderId) {
  const order = await Order.findById(orderId);
  if (!order) throw httpError(404, "Order not found.");
  const ids = vendorIds.map(String);
  const parcels = [...(order.shippingBreakdown || [])];
  const at = parcels.findIndex((p) => p.method === "RIDER" && ids.includes(idOf(p.vendor)));
  const parcel = parcels[at];
  if (!parcel) throw httpError(409, "This parcel isn't waiting for an Ikiguzi rider.");
  const vendorId = idOf(parcel.vendor);
  const delivery = await Delivery.findOne({ order: order._id, vendor: vendorId, status: { $ne: "CANCELLED" } });
  if (delivery?.rider || (delivery && delivery.status !== "READY_FOR_PICKUP")) {
    throw httpError(409, "A rider has already accepted this parcel. Ask Ikiguzi support if they can't come.", "RIDER_ASSIGNED");
  }
  if (delivery) {
    delivery.status = "CANCELLED";
    delivery.history = withHistory(delivery, "CANCELLED", "The seller delivers it");
    await delivery.save();
  }
  parcels[at] = { ...parcel, method: "STANDARD", source: "seller", eta: "The seller delivers it", zoneName: "Seller delivery" };
  order.shippingBreakdown = parcels;
  await order.save();
  socketService.emitOrderStatusUpdate(order);
  notifications.notify(order.user, {
    type: "DELIVERY",
    title: `${parcel.storeName || "The seller"} is delivering your parcel`,
    message: "Give the seller your 6-digit delivery code only when you have the parcel in hand.",
    link: `/orders/${idOf(order)}`,
  }).catch(() => {});
  return { order };
}

/**
 * The buyer paid for a parcel the seller delivers because its store has no
 * pickup pin: the seller is told how to let Ikiguzi riders carry the next ones.
 */
async function nudgePinless(order) {
  for (const parcel of order.shippingBreakdown || []) {
    if (!parcel.vendor || ["RIDER", "PICKUP"].includes(parcel.method)) continue;
    const store = parcel.store ? await Store.findById(parcel.store).select("pickupLat storeName").lean() : null;
    if (!store || store.pickupLat != null) continue;
    const owner = await User.findById(idOf(parcel.vendor)).select("role").lean();
    notifications.notify(parcel.vendor, {
      type: "DELIVERY",
      title: "Deliver this order yourself, or pin your store",
      message: `${store.storeName} has no pickup pin, so no Ikiguzi rider can collect this order: deliver it and confirm with the buyer's code. Put your store on the map so riders carry the next ones.`,
      link: owner?.role === "supplier" ? "/supplier/settings" : "/vendor/store",
    }).catch(() => {});
  }
}

/** Whether a rider (not the seller) carries this seller's parcel of the order. */
const isRiderParcel = (order, vendorId) =>
  (order.shippingBreakdown || []).some((p) => p.method === "RIDER" && idOf(p.vendor) === String(vendorId));

/* --------------------------------- admin -------------------------------- */

async function listRiders({ status } = {}) {
  const riders = await Rider.find(status ? { status } : {}).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: riders.map((r) => idOf(r.user)) } }).select("Fullname phone").lean();
  const byId = new Map(users.map((u) => [idOf(u), u]));
  return { riders: riders.map((r) => riderAccount(r, byId.get(idOf(r.user)))) };
}

async function reviewRider(riderId, { status, note } = {}) {
  const next = String(status || "").toUpperCase();
  if (!["APPROVED", "REJECTED", "SUSPENDED"].includes(next)) throw httpError(400, "Choose approve, reject or suspend.");
  if (next !== "APPROVED" && String(note || "").trim().length < 5) throw httpError(400, "Say why, so the rider knows what to fix.");
  const rider = await Rider.findById(riderId);
  if (!rider) throw httpError(404, "Rider not found.");
  rider.status = next;
  rider.reviewNote = next === "APPROVED" ? null : String(note).trim().slice(0, 300);
  if (next !== "APPROVED") rider.isOnline = false;
  await rider.save();
  const text = { APPROVED: "You're approved. Go online in the Ikiguzi app to start taking deliveries.", REJECTED: `Your rider application was not approved: ${rider.reviewNote}`, SUSPENDED: `Your rider account was suspended: ${rider.reviewNote}` }[next];
  notifications.notify(rider.user, { type: "SYSTEM", title: "Your rider account", message: text, link: "/delivery", sms: `Ikiguzi: ${text}` }).catch(() => {});
  return { rider: riderAccount(rider, await User.findById(idOf(rider.user)).select("Fullname phone").lean()) };
}

module.exports = {
  setArea,
  createForOrder, orderPaid, markReady, sellerStepped, dispatch, wakeRiders, expireStaleOffers, checkLatePickups, cancelForOrder, isRiderParcel,
  checkUnclaimed, sellerDelivers,
  register, profile, updateLocation, setAvailability, listAvailable, active, offerFor, accept, reject, release, updateStatus, confirm, history, stats, wallet,
  listRiders, reviewRider, adminRelease,
};
