require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Product = require("../../src/models/Product");
const AdBooking = require("../../src/models/AdBooking");
const Disbursement = require("../../src/models/Disbursement");
const Category = require("../../src/models/Category");
const Rider = require("../../src/models/Rider");

jest.setTimeout(90000);

// "Advertise here": 1,000 RWF per product, Ikiguzi approves or rejects and refunds.
describe("Home page ad bookings", () => {
  let app;
  let seller, buyer, admin, products;
  const tokens = {};
  const secret = "ad_bookings_secret";
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox: payments succeed at once
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/ad-bookings", require("../../src/routes/adBooking.routes"));
    app.use("/api/advertisements", require("../../src/routes/advertisement.routes"));
    app.use("/api/admin", require("../../src/routes/admin.ops.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880008${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    seller = await make("Kigali Shop", "vendor", 1);
    buyer = await make("Aline Buyer", "buyer", 2);
    admin = await make("Admin", "super_admin", 3);
    await Vendor.create({ user: seller._id, businessName: "Kigali Shop", phone: "0788000801", email: "shop@example.com", verificationStatus: "VERIFIED" });
    const category = await Category.create({ name: "Home", slug: "home" });
    products = [];
    for (const name of ["Lamp", "Chair", "Mat"]) {
      products.push(await Product.create({ vendor: seller._id, category: category._id, name, description: `${name}.`, price: 5000, stockQuantity: 4, status: "ACTIVE", media: { mainImage: "/x.png", gallery: [] } }));
    }
    for (const [k, u] of Object.entries({ seller, buyer, admin })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const book = (who, ids) => request(app).post("/api/ad-bookings").set(as(who)).send({ productIds: ids.map((p) => String(p._id)), phoneNumber: "0788123456" });

  test("buyers can't advertise; sellers pay per product and wait for Ikiguzi", async () => {
    expect((await book("buyer", products.slice(0, 1))).status).toBe(403);
    const res = await book("seller", products.slice(0, 3));
    expect(res.status).toBe(200);
    expect([res.body.booking.status, res.body.booking.amount]).toEqual(["PAID", 3000]);

    // Not on the home page until approved; then it is, first.
    const hero = async () => (await request(app).get("/api/advertisements?placement=HOMEPAGE_HERO")).body.data.map((d) => d.product.name);
    expect(await hero()).toEqual([]);
    const attention = await request(app).get("/api/admin/attention").set(as("admin"));
    expect(attention.body.items.find((i) => i.key === "adBookings").count).toBe(1);
    const ok = await request(app).post(`/api/ad-bookings/${res.body.booking.id}/approve`).set(as("admin"));
    expect(ok.body.booking.status).toBe("LIVE");
    expect((await hero()).sort()).toEqual(["Chair", "Lamp", "Mat"]);
  });

  test("a rejected booking is refunded to the number that paid", async () => {
    const res = await book("seller", products.slice(0, 2));
    expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "no" })).status).toBe(400);
    const rejected = await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "The photo is blurry." });
    expect(rejected.body.booking.status).toBe("REJECTED");
    const refund = await Disbursement.findOne({ idempotencyKey: `ad-booking-refund:${res.body.booking.id}` });
    expect([refund.kind, Number(refund.amount)]).toEqual(["REFUND", 2000]);
    expect(refund.phone).toContain("788123456");
    // Can't approve it afterwards.
    expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/approve`).set(as("admin"))).status).toBe(409);
  });

  test("riders waiting for approval show in Needs your attention", async () => {
    const riderUser = await User.create({ Fullname: "New Rider", email: "r@example.com", password: "password123", phone: "0788000899", gender: "male", role: "delivery", isOnboarded: true });
    await Rider.create({ user: riderUser._id, vehicleType: "MOTORBIKE", plateNumber: "RAB111A", status: "PENDING" });
    const attention = await request(app).get("/api/admin/attention").set(as("admin"));
    const riders = attention.body.items.find((i) => i.key === "riders");
    expect([riders.count, riders.link]).toEqual([1, "/admin/riders"]);
    expect(attention.body.badges["/admin/riders"]).toBe(1);
  });

  test("pricing is public and follows the admin setting", async () => {
    const res = await request(app).get("/api/ad-bookings/pricing");
    expect([res.body.pricePerProduct, res.body.days]).toEqual([1000, 7]);
    expect(await AdBooking.countDocuments({})).toBe(0);
  });
});
