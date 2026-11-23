// Delivery fee calculation from seller shipping zones.
//
// Items are shipped per store (a seller with two stores ships two parcels).
// For each store the most specific ACTIVE zone covering the buyer's address
// is used: a district match beats a province match, which beats a nationwide
// zone (no provinces or districts listed). Zone lookup order:
//   1. the store's zones  2. the seller's other zones  3. Ikiguzi platform zones
//   (vendor: null)  4. built-in Ikiguzi defaults below.
// A seller who has zones, none of which cover the address, does not deliver there.
const deliveryConfig = require("../config/delivery");
const ShippingZone = require("../models/ShippingZone");
const Store = require("../models/Store");
const { getPrimaryStore } = require("../utils/vendorStore.util");
const { provinceOfDistrict } = require("../config/rwandaLocations");

// Used only when neither the seller nor Ikiguzi has configured any zone.
const DEFAULT_ZONES = [
  // Delivery is never free: standard delivery always has a price.
  { _id: null, name: "Kigali City (Ikiguzi standard)", provinces: ["Kigali City"], districts: [], fee: 2000, freeOverAmount: 0, eta: "Same day – 1 day", methods: ["STANDARD"] },
  { _id: null, name: "Rest of Rwanda (Ikiguzi standard)", provinces: [], districts: [], fee: 5000, freeOverAmount: 0, eta: "1–3 days", methods: ["STANDARD"] },
];

// Stored zone methods may still list EXPRESS (older zones); checkout no longer offers it.
const lc = (v) => String(v || "").trim().toLowerCase();

const normalizeAddress = (address = {}) => {
  const district = address.district || address.city || "";
  const province = address.province || provinceOfDistrict(district) || address.state || "";
  return { province, district };
};

// 3 = district match, 2 = province match, 1 = nationwide, 0 = not covered.
const coverageScore = (zone, { province, district }) => {
  const districts = (zone.districts || []).map(lc);
  const provinces = (zone.provinces || []).map(lc);
  if (districts.length) return districts.includes(lc(district)) ? 3 : 0;
  if (provinces.length) return provinces.includes(lc(province)) ? 2 : 0;
  return 1;
};

const bestZone = (zones, address) => {
  let best = null;
  let bestScore = 0;
  for (const zone of zones) {
    const score = coverageScore(zone, address);
    if (score > bestScore || (score === bestScore && score > 0 && Number(zone.fee) < Number(best.fee))) {
      best = zone;
      bestScore = score;
    }
  }
  return best;
};

// Fee for a method in a zone; express falls back to standard when not offered.
// Two ways only: the buyer collects (PICKUP, handled before zones) or it is
// delivered (STANDARD). Express is gone and delivery is never free: an old
// client asking for EXPRESS gets STANDARD, and a zone's free-over amount is ignored.
const feeFor = (zone, requested) => {
  const fee = zone.fee ?? zone.expressFee ?? 0;
  return { method: "STANDARD", fee: Math.max(0, Math.round(Number(fee) || 0)), fellBack: false };
};

const zonesForStore = async (vendorId, storeId, cache) => {
  const key = `${vendorId}:${storeId}`;
  if (cache.has(key)) return cache.get(key);
  const vendorZones = await ShippingZone.find({ vendor: vendorId, status: "ACTIVE" }).lean();
  let result;
  if (vendorZones.length) {
    const own = vendorZones.filter((z) => String(z.store) === String(storeId));
    result = { zones: own.length ? own : vendorZones, source: "seller" };
  } else {
    const platform = await ShippingZone.find({ vendor: null, status: "ACTIVE" }).lean();
    result = platform.length ? { zones: platform, source: "platform" } : { zones: DEFAULT_ZONES, source: "default" };
  }
  cache.set(key, result);
  return result;
};

/**
 * Where a buyer collects an order from each store: { [storeId]: { storeName, address, phone } }.
 */
exports.pickupLocations = async (storeIds) => {
  const ids = [...new Set((storeIds || []).filter(Boolean).map(String))];
  if (!ids.length) return {};
  const stores = await Store.find({ _id: { $in: ids } }).lean();
  return Object.fromEntries(stores.map((s) => {
    const street = s.businessAddress || s.address?.street || s.addressStreet || "";
    const city = s.address?.city || s.addressCity || "";
    return [String(s._id), {
      storeName: s.storeName,
      address: [street, city].filter(Boolean).join(", ") || "Ask the seller for the pickup address",
      phone: s.businessPhone || s.contactPhone || "",
    }];
  }));
};

/**
 * Quote delivery for order lines.
 * lines: [{ product (doc with vendor/store), quantity, price }]
 * Returns { shippingFee, deliverable, method, groups: [...] }.
 */
exports.quoteShipping = async ({ lines, address, method = "STANDARD" }) => {
  const where = normalizeAddress(address);
  const requested = String(method || "STANDARD").toUpperCase() === "PICKUP" ? "PICKUP" : "STANDARD";
  const primaryCache = new Map();
  const zoneCache = new Map();
  const groupsByKey = new Map();

  for (const line of lines) {
    const vendorId = String(line.product.vendor);
    let storeId = line.product.store ? String(line.product.store) : null;
    if (!storeId) {
      if (!primaryCache.has(vendorId)) primaryCache.set(vendorId, await getPrimaryStore(vendorId));
      storeId = primaryCache.get(vendorId)?._id ? String(primaryCache.get(vendorId)._id) : null;
    }
    const key = `${vendorId}:${storeId}`;
    const group = groupsByKey.get(key) || { vendor: vendorId, store: storeId, subtotal: 0, items: 0 };
    group.subtotal += Number(line.price) * Number(line.quantity);
    group.items += Number(line.quantity);
    groupsByKey.set(key, group);
  }

  const storeIds = [...groupsByKey.values()].map((g) => g.store).filter(Boolean);
  const stores = await Store.find({ _id: { $in: storeIds } }).select("storeName pickupLat pickupLng riderDelivery").lean();
  const storeNames = Object.fromEntries(stores.map((s) => [String(s._id), s.storeName]));
  const storeById = new Map(stores.map((s) => [String(s._id), s]));
  let drop = address?.lat != null && address?.lng != null ? { lat: Number(address.lat), lng: Number(address.lng) } : null;
  // No door pin, but a store here uses Ikiguzi riders: pin the typed address
  // (street, sector, district) so riders are still offered the parcel. The
  // rider gets the full address and the buyer's phone once they accept.
  let approximatePin = null;
  if (!drop && requested !== "PICKUP" && stores.some((s) => s.riderDelivery && s.pickupLat != null)) {
    approximatePin = await require("./geocode.service").approximate(address || {});
    if (approximatePin) drop = { lat: approximatePin.lat, lng: approximatePin.lng };
  }

  // The buyer collects the order from each store: no delivery fee, and the
  // buyer's address doesn't matter.
  if (requested === "PICKUP") {
    const locations = await exports.pickupLocations(storeIds);
    const groups = [...groupsByKey.values()].map((group) => ({
      ...group, storeName: storeNames[group.store] || "Seller", deliverable: true, fee: 0, method: "PICKUP",
      eta: "Collect when the seller says it's ready", zone: null, zoneName: "Pickup", source: "pickup",
      pickup: locations[group.store] || null, message: null,
    }));
    return { address: where, method: "PICKUP", deliverable: true, shippingFee: 0, groups };
  }

  const groups = [];
  for (const group of groupsByKey.values()) {
    // A store using Ikiguzi riders: priced by distance from its pin to the buyer's.
    const store = storeById.get(group.store);
    if (store?.riderDelivery && store.pickupLat != null && drop) {
      const trip = deliveryConfig.quote({ lat: store.pickupLat, lng: store.pickupLng }, drop);
      if (trip.withinRange) {
        groups.push({
          ...group, storeName: store.storeName, deliverable: true, fee: trip.fee, method: "RIDER", eta: "Today, by an Ikiguzi rider",
          zone: null, zoneName: "Ikiguzi rider", source: "rider", distanceKm: trip.km, message: null,
        });
        continue;
      }
    }
    const { zones, source } = await zonesForStore(group.vendor, group.store, zoneCache);
    const zone = bestZone(zones, where);
    const storeName = storeNames[group.store] || "Seller";
    if (!zone) {
      groups.push({
        ...group, storeName, deliverable: false, fee: 0, method: null, eta: null, zone: null, zoneName: null, source,
        message: `${storeName} doesn't deliver to ${where.district || where.province || "this address"} yet.`,
      });
      continue;
    }
    const { method: used, fee, fellBack } = feeFor(zone, requested);
    groups.push({
      ...group, storeName, deliverable: true, fee, method: used, eta: zone.eta, zone: zone._id || null, zoneName: zone.name, source,
      freeOverAmount: null,
      message: fellBack ? `${storeName} doesn't offer ${requested.toLowerCase()} delivery; ${used.toLowerCase()} is used.` : null,
    });
  }

  return {
    address: where,
    method: requested,
    // Set when the drop pin came from the typed address (checkout saves it on the order).
    approximatePin,
    deliverable: groups.every((g) => g.deliverable),
    shippingFee: groups.reduce((s, g) => s + g.fee, 0),
    groups,
  };
};

// Seller-side preview: what a buyer at this address would pay for one store.
exports.previewForStore = async ({ vendorId, storeId, address, subtotal = 0, method = "STANDARD" }) => {
  const where = normalizeAddress(address);
  const { zones, source } = await zonesForStore(vendorId, storeId, new Map());
  const zone = bestZone(zones, where);
  if (!zone) return { address: where, source, deliverable: false };
  const { method: used, fee } = feeFor(zone, String(method).toUpperCase());
  return { address: where, source, deliverable: true, zone: zone._id, zoneName: zone.name, method: used, fee, eta: zone.eta };
};

exports.normalizeAddress = normalizeAddress;
exports.DEFAULT_ZONES = DEFAULT_ZONES;
