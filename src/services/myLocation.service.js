// The phone's or browser's position when someone signs in (they agreed to
// share it). It fills each pin the account still lacks, and never moves a pin
// the person already placed:
//   buyer    → their default delivery address (and checkout's starting pin)
//   seller   → their primary store's pickup pin (riders then collect there)
//   supplier → their primary store's pickup pin, copied to their shop
//   rider    → their current position
// Admins and affiliates have nothing to pin.
const User = require("../models/User");
const Store = require("../models/Store");
const { readPin } = require("../config/delivery");

const idOf = (v) => String(v?._id || v?.id || v || "");

async function save(authUser, body = {}) {
  const pin = readPin(body, { required: true, label: "your location" });
  const user = await User.findById(idOf(authUser));
  if (!user) throw Object.assign(new Error("Account not found."), { statusCode: 404 });
  const pinned = [];

  // Remembered for every account: checkout starts here when no address has a pin.
  user.preferences = { ...(user.preferences || {}), lastPin: { lat: pin.lat, lng: pin.lng, at: new Date().toISOString() } };

  if (user.role === "buyer") {
    const addresses = user.addresses || [];
    const target = addresses.find((a) => a.isDefaultShipping) || addresses[0];
    if (target && target.lat == null) {
      target.lat = pin.lat;
      target.lng = pin.lng;
      pinned.push("your delivery address");
    }
  }
  await user.save();

  if (user.role === "vendor") {
    const store = (await Store.findOne({ vendor: user._id, isPrimary: true })) || (await Store.findOne({ vendor: user._id }));
    if (store && store.pickupLat == null) {
      await Store.updateOne({ _id: store._id }, { $set: { pickupLat: pin.lat, pickupLng: pin.lng, riderDelivery: true } });
      pinned.push("your store");
    }
  }

  if (user.role === "supplier") {
    const Supplier = require("../models/Supplier");
    const SupplierStore = require("../models/SupplierStore");
    const supplierStores = require("./supplierStore.service");
    const supplier = await Supplier.findOne({ user: user._id });
    if (supplier) {
      const store = await supplierStores.primaryStore(supplier);
      if (store.pickupLat == null) {
        await SupplierStore.updateOne({ _id: store._id }, { $set: { pickupLat: pin.lat, pickupLng: pin.lng, riderDelivery: true } });
        await supplierStores.syncShopPickup(supplier, { ...(store.toObject?.() || store), isPrimary: true, pickupLat: pin.lat, pickupLng: pin.lng, riderDelivery: true });
        pinned.push("your store");
      }
    }
  }

  if (user.role === "delivery") {
    const Rider = require("../models/Rider");
    if (await Rider.exists({ user: user._id })) {
      await Rider.updateOne({ user: user._id }, { $set: { lat: pin.lat, lng: pin.lng, locationAt: new Date() } });
      pinned.push("your position");
    }
  }

  return {
    pinned,
    lastPin: { lat: pin.lat, lng: pin.lng },
    message: pinned.length ? `Pinned ${pinned.join(" and ")} on the map. You can move the pin any time.` : "Location saved.",
  };
}

module.exports = { save };
