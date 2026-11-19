require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Store = require("../../src/models/Store");
const Rider = require("../../src/models/Rider");
const geocode = require("../../src/services/geocode.service");

jest.setTimeout(60000);

describe("Pins from the street and from the device", () => {
  let app;
  const secret = "geo_location_secret";
  const realFetch = global.fetch;
  const tokenFor = (u) => ({ Authorization: `Bearer ${jwt.sign({ userId: u._id }, secret)}` });
  const make = (role, n, extra = {}) => User.create({ Fullname: `${role} ${n}`, companyName: `${role} ${n}`, email: `${role}${n}@example.com`, password: "password123", phone: `07880007${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true, ...extra });

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/geo", require("../../src/routes/geo.routes"));
  });
  afterAll(async () => {
    global.fetch = realFetch;
    await db.close();
  });
  beforeEach(async () => {
    await db.reset();
    geocode._cache.clear();
  });

  test("a street becomes a pin in Rwanda; places abroad are dropped", async () => {
    const asked = [];
    global.fetch = async (url) => {
      asked.push(String(url));
      return { ok: true, json: async () => [
        { display_name: "KG 11 Avenue, Remera, Gasabo, Kigali, Rwanda", lat: "-1.9578", lon: "30.1127" },
        { display_name: "Somewhere, Uganda", lat: "0.31", lon: "32.58" },
      ] };
    };
    const res = await request(app).get("/api/geo/search").query({ q: "KG 11 Ave, Remera" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ label: "KG 11 Avenue, Remera, Gasabo, Kigali", lat: -1.9578, lng: 30.1127 }]);
    expect(asked[0]).toMatch(/countrycodes=rw/);
    // Cached: the second search doesn't call the map service again.
    await request(app).get("/api/geo/search").query({ q: "kg 11 ave, remera" });
    expect(asked).toHaveLength(1);
    expect((await request(app).get("/api/geo/search").query({ q: "ab" })).body.results).toEqual([]);
  });

  test("signing in with location pins the store and the buyer's address, but never moves a pin already placed", async () => {
    const vendor = await make("vendor", 1);
    await Store.create({ vendor: vendor._id, isPrimary: true, storeName: "Pinless Shop", slug: "pinless-shop", contactEmail: "p@example.com", contactPhone: "0788000701", status: "ACTIVE", riderDelivery: false });
    const here = { lat: -1.95, lng: 30.09 };
    const res = await request(app).post("/api/geo/me").set(tokenFor(vendor)).send(here);
    expect(res.status).toBe(200);
    expect(res.body.pinned).toEqual(["your store"]);
    const store = await Store.findOne({ vendor: vendor._id }).lean();
    expect([store.pickupLat, store.pickupLng, store.riderDelivery]).toEqual([here.lat, here.lng, true]);
    // A second sign-in elsewhere leaves the pin alone.
    expect((await request(app).post("/api/geo/me").set(tokenFor(vendor)).send({ lat: -2.5, lng: 29.7 })).body.pinned).toEqual([]);
    expect((await Store.findOne({ vendor: vendor._id }).lean()).pickupLat).toBe(here.lat);

    const buyer = await make("buyer", 2);
    buyer.addresses.push({ type: "home", country: "Rwanda", provinceState: "Kigali City", sector: "Remera", street: "KG 11 Ave", cityDistrict: "Gasabo", phone: "+250788000702", isDefaultShipping: true });
    await buyer.save();
    expect((await request(app).post("/api/geo/me").set(tokenFor(buyer)).send(here)).body.pinned).toEqual(["your delivery address"]);
    const saved = await User.findById(buyer._id);
    expect(saved.addresses[0].lat).toBe(here.lat);
    expect(saved.preferences.lastPin.lat).toBe(here.lat);

    expect((await request(app).post("/api/geo/me").set(tokenFor(buyer)).send({ lat: 5, lng: 5 })).status).toBe(400);
  });

  test("a rider's position is updated", async () => {
    const rider = await make("delivery", 3);
    await Rider.create({ user: rider._id, vehicleType: "BICYCLE", status: "APPROVED" });
    expect((await request(app).post("/api/geo/me").set(tokenFor(rider)).send({ lat: -1.94, lng: 30.06 })).body.pinned).toEqual(["your position"]);
    expect((await Rider.findOne({ user: rider._id }).lean()).lat).toBe(-1.94);
  });
});
