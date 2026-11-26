require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Product = require("../../src/models/Product");
const AdBooking = require("../../src/models/AdBooking");
const Payment = require("../../src/models/Payment");
const LedgerEntry = require("../../src/models/LedgerEntry");
const Disbursement = require("../../src/models/Disbursement");
const Category = require("../../src/models/Category");
const Rider = require("../../src/models/Rider");
const paymentService = require("../../src/services/payment.service");
const adBookings = require("../../src/services/adBooking.service");

jest.setTimeout(90000);

// "Advertise here": every ad costs one flat price (5,000 RWF) and shows 5
// seconds a turn; the server sets both, and a verified payment
// puts the ad live straight away. Ikiguzi can pause, remove or refund it.
describe("Home page ad bookings", () => {
  let app;
  let seller, otherSeller, buyer, admin, products;
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
    otherSeller = await make("Other Shop", "vendor", 4);
    await Vendor.create({ user: seller._id, businessName: "Kigali Shop", phone: "0788000801", email: "shop@example.com", verificationStatus: "VERIFIED" });
    const category = await Category.create({ name: "Home", slug: "home" });
    products = [];
    for (const name of ["Lamp", "Chair", "Mat"]) {
      products.push(await Product.create({ vendor: seller._id, category: category._id, name, description: `${name}.`, price: 5000, stockQuantity: 4, status: "ACTIVE", media: { mainImage: "/x.png", gallery: [] } }));
    }
    for (const [k, u] of Object.entries({ seller, otherSeller, buyer, admin })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const ad = (extra = {}) => ({
    productId: String(products[0]._id), title: "Lamps that last", description: "Warm light for every room in the house.",
    seconds: 3, paymentMethod: "MOMO", phoneNumber: "0788123456", ...extra,
  });
  const book = (who, body = ad()) => request(app).post("/api/ad-bookings").set(as(who)).send(body);
  const hero = async () => (await request(app).get("/api/advertisements?placement=HOMEPAGE_HERO")).body.data;
  const approve = (id) => request(app).post(`/api/ad-bookings/${id}/approve`).set(as("admin"));
  const feeEntries = (b) => LedgerEntry.countDocuments({ transactionReference: b.bookingNumber, entryType: "AD_PLACEMENT_FEE" });

  describe("pricing, banner time and validation", () => {
    test("every ad costs the flat price and shows 5 seconds, whatever the client asks for", async () => {
      for (const extra of [{}, { seconds: 20 }, { amount: 100 }, { seconds: 60, amount: 999999 }]) {
        await AdBooking.deleteMany({});
        const res = await book("seller", ad(extra));
        expect(res.status).toBe(200);
        expect([res.body.booking.amount, res.body.booking.displaySeconds, res.body.booking.paymentMethod]).toEqual([5000, 5, "MOMO"]);
      }
    });

    test("what the client sends about status, payment or seconds is ignored", async () => {
      const res = await book("seller", ad({ seconds: 3, displaySeconds: 60, status: "LIVE", paymentStatus: "SUCCESS", amount: 1, days: 999, startsAt: new Date() }));
      expect(res.status).toBe(200);
      expect([res.body.booking.displaySeconds, res.body.booking.status, res.body.booking.amount]).toEqual([5, "LIVE", 5000]);
      expect(res.body.booking.days).toBe(7);
      expect((await hero()).map((h) => h.displaySeconds)).toEqual([5]); // live because it was paid for, not because the client said so
    });

    test("the title and description are required and bounded", async () => {
      expect((await book("seller", ad({ title: "  " }))).status).toBe(400);
      expect((await book("seller", ad({ title: "x".repeat(61) }))).status).toBe(400);
      expect((await book("seller", ad({ description: "" }))).status).toBe(400);
      expect((await book("seller", ad({ description: "y".repeat(1001) }))).status).toBe(400);
      const ok = await book("seller", ad({ title: "  Spaced   out  ", description: "z".repeat(900) }));
      expect(ok.status).toBe(200);
      expect(ok.body.booking.title).toBe("Spaced out");
    });

    test("only your own, on-sale products can be advertised", async () => {
      expect((await book("otherSeller")).status).toBe(400); // not their product
      expect((await book("seller", ad({ productId: "nope" }))).status).toBe(400);
      await Product.updateOne({ _id: products[0]._id }, { $set: { stockQuantity: 0 } });
      expect((await book("seller")).status).toBe(400);
    });

    test("pricing, quote and payment methods are public", async () => {
      const p = (await request(app).get("/api/ad-bookings/pricing")).body;
      expect([p.price, p.seconds, p.days]).toEqual([5000, 5, 7]);
      const q = (await request(app).get("/api/ad-bookings/quote?amount=22000")).body;
      expect([q.seconds, q.amount, q.days]).toEqual([5, 5000, 7]);
      const m = (await request(app).get("/api/ad-bookings/payment-methods")).body.methods;
      expect(m.map((x) => x.id)).toEqual(["MOMO", "AIRTEL"]);
      expect(m.every((x) => x.available)).toBe(true);
    });
  });

  describe("payment methods", () => {
    test("a method is required, and the number must belong to it", async () => {
      expect((await book("seller", ad({ paymentMethod: undefined }))).status).toBe(400);
      expect((await book("seller", ad({ paymentMethod: "BITCOIN" }))).status).toBe(400);
      expect((await book("seller", ad({ paymentMethod: "AIRTEL", phoneNumber: "0788123456" }))).status).toBe(400); // an MTN number
      expect((await book("seller", ad({ paymentMethod: "MOMO", phoneNumber: "0731234567" }))).status).toBe(400); // an Airtel number
      expect((await book("seller", ad({ phoneNumber: "12345" }))).status).toBe(400);
      expect(await AdBooking.countDocuments({})).toBe(0);
      const airtel = await book("seller", ad({ paymentMethod: "AIRTEL", phoneNumber: "0731234567" }));
      expect([airtel.status, airtel.body.booking.paymentMethod]).toEqual([200, "AIRTEL"]);
    });
  });

  describe("approval and the home banner", () => {
    test("buyers can't advertise; a paid ad goes live by itself, with its title, description and seconds", async () => {
      expect((await book("buyer")).status).toBe(403);
      expect(await hero()).toEqual([]);
      const res = await book("seller", ad({ seconds: 10 }));
      expect([res.body.booking.status, res.body.booking.paymentStatus, res.body.booking.amount]).toEqual(["LIVE", "SUCCESS", 5000]);

      const [slide] = await hero();
      expect([slide.product.name, slide.title, slide.description, slide.displaySeconds]).toEqual(["Lamp", "Lamps that last", "Warm light for every room in the house.", 5]);
      expect(new Date(res.body.booking.endsAt) > new Date()).toBe(true);
      expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/approve`).set(as("seller"))).status).toBe(403);
      expect((await approve(res.body.booking.id)).status).toBe(409); // nothing left to approve
    });

    test("a booking left PAID (the page never saw it go live) goes live the next time the banner is read", async () => {
      const b = await AdBooking.create({
        bookingNumber: "ADB-STUCK-1", seller: String(seller._id), sellerRole: "vendor", product: String(products[0]._id),
        products: [{ id: String(products[0]._id), name: "Lamp", image: "/x.png" }], title: "Stuck", description: "Was waiting.",
        displaySeconds: 11, pricePerProduct: 13000, amount: 13000, days: 7, paymentMethod: "MOMO", status: "PAID", paymentStatus: "SUCCESS", paidAt: new Date(),
      });
      expect((await hero()).map((h) => [h.title, h.displaySeconds])).toEqual([["Stuck", 11]]);
      expect((await AdBooking.findById(b._id)).status).toBe("LIVE");
    });

    test("the fee stays in escrow while the ad runs and becomes Ikiguzi's once, when it ends", async () => {
      const b = await book("seller", ad({ seconds: 5 }));
      expect(await feeEntries(b.body.booking)).toBe(0);
      await hero();
      expect(await feeEntries(b.body.booking)).toBe(0);
      await AdBooking.updateOne({ _id: b.body.booking.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
      await hero();
      await hero();
      expect((await AdBooking.findById(b.body.booking.id)).status).toBe("ENDED");
      expect(await feeEntries(b.body.booking)).toBe(1);
    });

    test("an older flat-fee booking still waits for approval, and earns its fee once when approved", async () => {
      const b = await AdBooking.create({
        bookingNumber: "ADB-OLD-PAID", seller: String(seller._id), sellerRole: "vendor", pricePerProduct: 1000, amount: 1000, days: 7,
        products: [{ id: String(products[1]._id), name: "Chair", image: "/x.png" }], status: "PAID", paymentStatus: "SUCCESS", paidAt: new Date(),
      });
      expect(await hero()).toEqual([]);
      const [a, c] = await Promise.all([approve(b._id), approve(b._id)]);
      expect([a.status, c.status].sort()).toEqual([200, 409]);
      expect(await feeEntries(b)).toBe(1);
      expect((await hero()).length).toBe(1);
    });

    test("every ad gets the same 5 seconds, whatever was asked for", async () => {
      for (const [i, seconds] of [3, 10, 20].entries()) {
        const b = await book("seller", ad({ productId: String(products[i]._id), seconds }));
        await approve(b.body.booking.id);
      }
      const bySeconds = Object.fromEntries((await hero()).map((s) => [s.product.name, s.displaySeconds]));
      expect(bySeconds).toEqual({ Lamp: 5, Chair: 5, Mat: 5 });
    });

    test("expired, paused, removed, unpaid and sold-out ads do not show", async () => {
      const b = await book("seller", ad());
      await approve(b.body.booking.id);
      expect((await hero()).length).toBe(1);

      // Paused → gone; put back → shows.
      expect((await request(app).post(`/api/ad-bookings/${b.body.booking.id}/deactivate`).set(as("admin"))).body.booking.status).toBe("PAUSED");
      expect(await hero()).toEqual([]);
      expect((await request(app).post(`/api/ad-bookings/${b.body.booking.id}/reactivate`).set(as("admin"))).body.booking.status).toBe("LIVE");
      expect((await hero()).length).toBe(1);

      // The product goes out of stock → gone.
      await Product.updateOne({ _id: products[0]._id }, { $set: { status: "OUT_OF_STOCK" } });
      expect(await hero()).toEqual([]);
      await Product.updateOne({ _id: products[0]._id }, { $set: { status: "ACTIVE" } });
      expect((await hero()).length).toBe(1);

      // LIVE without a successful payment never shows.
      await AdBooking.updateOne({ _id: b.body.booking.id }, { $set: { paymentStatus: "PENDING" } });
      expect(await hero()).toEqual([]);
      await AdBooking.updateOne({ _id: b.body.booking.id }, { $set: { paymentStatus: "SUCCESS" } });

      // Past its end date → gone, even before anything marks it ENDED.
      await AdBooking.updateOne({ _id: b.body.booking.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
      expect(await hero()).toEqual([]);
      expect((await AdBooking.findById(b.body.booking.id)).status).toBe("ENDED");
      expect((await request(app).post(`/api/ad-bookings/${b.body.booking.id}/reactivate`).set(as("admin"))).status).toBe(409);

      // Removed ads stay on record but never show.
      await AdBooking.updateOne({ _id: b.body.booking.id }, { $set: { status: "LIVE", endsAt: new Date(Date.now() + 86400000) } });
      expect((await hero()).length).toBe(1);
      expect((await request(app).post(`/api/ad-bookings/${b.body.booking.id}/remove`).set(as("admin")).send({ reason: "Misleading" })).body.booking.status).toBe("REMOVED");
      expect(await hero()).toEqual([]);
      expect(await AdBooking.countDocuments({})).toBe(1);
    });

    test("admin clicks on an ad that is already live change nothing", async () => {
      const b = await book("seller", ad());
      const [a, c] = await Promise.all([approve(b.body.booking.id), approve(b.body.booking.id)]);
      expect([a.status, c.status]).toEqual([409, 409]);
      expect(await feeEntries(b.body.booking)).toBe(0);
    });

    test("an older flat-fee booking with no title still shows, with the banner's own timing", async () => {
      await AdBooking.create({
        bookingNumber: "ADB-LEGACY-1", seller: String(seller._id), sellerRole: "vendor", pricePerProduct: 1000, amount: 2000, days: 7,
        products: [{ id: String(products[1]._id), name: "Chair", image: "/x.png" }, { id: String(products[2]._id), name: "Mat", image: "/x.png" }],
        status: "LIVE", paymentStatus: "SUCCESS", startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
      });
      const slides = await hero();
      expect(slides.map((s) => s.product.name).sort()).toEqual(["Chair", "Mat"]);
      expect(slides.every((s) => s.title === null && s.displaySeconds === null)).toBe(true);
    });
  });

  describe("payment verification", () => {
    // A booking whose payment the gateway has not confirmed yet.
    const waiting = async (overrides = {}) => {
      const booking = await AdBooking.create({
        bookingNumber: `ADB-W-${Date.now()}`, seller: String(seller._id), sellerRole: "vendor", product: String(products[0]._id),
        products: [{ id: String(products[0]._id), name: "Lamp", image: "/x.png" }], title: "Lamps", description: "Warm light.",
        displaySeconds: 10, pricePerProduct: 12000, amount: 12000, days: 7, paymentMethod: "MOMO", status: "AWAITING_PAYMENT", ...overrides,
      });
      const payment = await Payment.create({
        user: seller._id, transactionReference: `ADB-${booking._id}-${Date.now()}`, method: "MOMO", gateway: "PAYPACK", provider: "MTN",
        phoneNumber: "250788123456", amount: 12000, status: "PENDING", purpose: "AD_BOOKING",
      });
      return { booking, payment };
    };

    test("a pending payment activates nothing; a failed one cancels the booking", async () => {
      const { booking, payment } = await waiting();
      await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "PENDING", amount: 12000 });
      expect((await AdBooking.findById(booking._id)).status).toBe("AWAITING_PAYMENT");
      expect((await approve(booking._id)).status).toBe(409);

      await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "FAILED", amount: 12000 });
      const failed = await AdBooking.findById(booking._id);
      expect([failed.status, failed.paymentStatus]).toEqual(["CANCELLED", "FAILED"]);
      expect((await approve(booking._id)).status).toBe(409);
      expect(await hero()).toEqual([]);
    });

    test("a verified payment moves the booking to PAID once, however often the gateway repeats itself", async () => {
      const { booking, payment } = await waiting();
      const first = await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "SUCCESSFUL", amount: 12000 });
      const again = await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "SUCCESSFUL", amount: 12000 });
      expect([first.status, again.status]).toEqual(["SUCCESS", "ALREADY_PROCESSED"]);
      expect((await AdBooking.findById(booking._id)).status).toBe("LIVE");
      // Even calling the fulfilment step directly again changes nothing.
      expect(await adBookings.markPaid(await Payment.findById(payment._id))).toBeNull();
      const ledgerIn = await LedgerEntry.countDocuments({ transactionReference: booking.bookingNumber, entryType: "PAYMENT_RECEIVED" });
      expect(ledgerIn).toBe(1);
      expect((await hero()).length).toBe(1);
    });

    test("a payment for a different amount never activates the booking", async () => {
      const { booking, payment } = await waiting({ amount: 22000, pricePerProduct: 22000, displaySeconds: 20 });
      await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "SUCCESSFUL", amount: 12000 });
      expect((await AdBooking.findById(booking._id)).status).toBe("AWAITING_PAYMENT");
    });

    test("only a payment marked SUCCESS counts, and only from the seller who booked", async () => {
      const { booking, payment } = await waiting();
      expect(await adBookings.markPaid({ ...payment.toObject(), status: "PENDING" })).toBeNull();
      expect(await adBookings.markPaid({ ...payment.toObject(), status: "SUCCESS", user: String(otherSeller._id) })).toBeNull();
      expect((await AdBooking.findById(booking._id)).status).toBe("AWAITING_PAYMENT");
    });

    test("a second prompt for the same ad within two minutes is refused", async () => {
      await waiting();
      const res = await book("seller", ad({ seconds: 10 }));
      expect(res.status).toBe(409);
    });

    test("giving up before paying cancels the booking, and nobody else can cancel it", async () => {
      const { booking } = await waiting();
      expect((await request(app).post(`/api/ad-bookings/${booking._id}/cancel`).set(as("otherSeller"))).status).toBe(404);
      const res = await request(app).post(`/api/ad-bookings/${booking._id}/cancel`).set(as("seller"));
      expect([res.body.booking.status, res.body.booking.paymentStatus]).toEqual(["CANCELLED", "CANCELLED"]);
      expect((await request(app).post(`/api/ad-bookings/${booking._id}/cancel`).set(as("seller"))).status).toBe(409);
    });

    test("money that still arrives after a cancel is not lost: the ad goes live", async () => {
      const { booking, payment } = await waiting();
      await request(app).post(`/api/ad-bookings/${booking._id}/cancel`).set(as("seller"));
      await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "SUCCESSFUL", amount: 12000 });
      const paid = await AdBooking.findById(booking._id);
      expect([paid.status, paid.paymentStatus]).toEqual(["LIVE", "SUCCESS"]);
    });
  });

  test("a rejected ad is taken down and refunded to the number that paid, without Ikiguzi earning a fee", async () => {
    const res = await book("seller", ad({ seconds: 5 }));
    expect((await hero()).length).toBe(1);
    expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "no" })).status).toBe(400);
    const rejected = await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "The photo is blurry." });
    expect(rejected.body.booking.status).toBe("REJECTED");
    const refund = await Disbursement.findOne({ idempotencyKey: `ad-booking-refund:${res.body.booking.id}` });
    expect([refund.kind, Number(refund.amount)]).toEqual(["REFUND", 5000]);
    expect(refund.phone).toContain("788123456");
    expect(await hero()).toEqual([]);
    expect(await feeEntries(res.body.booking)).toBe(0);
    expect((await approve(res.body.booking.id)).status).toBe(409);
    expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "Again, please." })).status).toBe(409);
  });

  test("sellers see how their ad is used: where it sits in the banner, its share of the time, and its views and clicks", async () => {
    const mineOf = async (who) => (await request(app).get("/api/ad-bookings/mine").set(as(who))).body.bookings;
    const first = await book("seller", ad({ productId: String(products[0]._id), seconds: 10 }));
    await AdBooking.updateOne({ _id: first.body.booking.id }, { $set: { startsAt: new Date(Date.now() - 60000) } });
    const second = await book("seller", ad({ productId: String(products[1]._id), seconds: 5, title: "Chairs" }));

    const rows = await mineOf("seller");
    const a = rows.find((r) => r.id === first.body.booking.id);
    const c = rows.find((r) => r.id === second.body.booking.id);
    expect([a.statusLabel, a.paymentLabel, a.daysLeft]).toEqual(["Live on the home page", "Payment successful", 7]);
    expect(a.usage).toEqual({ showing: true, position: 2, liveAds: 2, secondsPerTurn: 5, cycleSeconds: 10, sharePercent: 50 });
    expect([c.usage.position, c.usage.sharePercent]).toEqual([1, 50]);
    expect(await mineOf("otherSeller")).toEqual([]);

    // A live ad whose product is off sale says so instead of claiming it shows.
    await Product.updateOne({ _id: products[1]._id }, { $set: { status: "OUT_OF_STOCK" } });
    expect((await mineOf("seller")).find((r) => r.id === c.id).usage).toEqual({ showing: false });

    const admin1 = await request(app).get("/api/ad-bookings/admin?status=LIVE").set(as("admin"));
    expect(admin1.body.bookings[0].sellerName).toBe("Kigali Shop");
    expect((await request(app).get("/api/ad-bookings/admin").set(as("seller"))).status).toBe(403);
  });

  test("the banner counts views and clicks, only for live ads", async () => {
    const live = await book("seller", ad());
    const number = live.body.booking.bookingNumber;
    const send = (id, event) => request(app).post("/api/ad-bookings/track").send({ id, event });
    for (const event of ["view", "view", "view", "click"]) expect((await send(number, event)).status).toBe(200);
    expect((await send(number, "purchase")).status).toBe(400);
    expect((await send("not-an-ad", "view")).status).toBe(400);
    await send("ADB-DOES-NOT-EXIST", "view"); // unknown ads are ignored, not an error
    let row = (await request(app).get("/api/ad-bookings/mine").set(as("seller"))).body.bookings[0];
    expect([row.views, row.clicks]).toEqual([3, 1]);

    await request(app).post(`/api/ad-bookings/${live.body.booking.id}/deactivate`).set(as("admin"));
    await send(number, "view");
    row = (await request(app).get("/api/ad-bookings/mine").set(as("seller"))).body.bookings[0];
    expect(row.views).toBe(3);
  });

  test("riders waiting for approval show in Needs your attention", async () => {
    const riderUser = await User.create({ Fullname: "New Rider", email: "r@example.com", password: "password123", phone: "0788000899", gender: "male", role: "delivery", isOnboarded: true });
    await Rider.create({ user: riderUser._id, vehicleType: "MOTORBIKE", plateNumber: "RAB111A", status: "PENDING" });
    const attention = await request(app).get("/api/admin/attention").set(as("admin"));
    const riders = attention.body.items.find((i) => i.key === "riders");
    expect([riders.count, riders.link]).toEqual([1, "/admin/riders"]);
    expect(attention.body.badges["/admin/riders"]).toBe(1);
  });
  describe("sellers edit and delete their own ads", () => {
    const edit = (who, id, body) => request(app).patch(`/api/ad-bookings/${id}`).set(as(who)).send(body);
    const del = (who, id) => request(app).delete(`/api/ad-bookings/${id}`).set(as(who));

    test("editing changes what the home page shows, and never the status, price or dates", async () => {
      const booked = (await book("seller")).body.booking;
      expect(booked.status).toBe("LIVE");
      const res = await edit("seller", booked.id, { title: "  New   title ", description: "A brand new description.", productId: String(products[1]._id), status: "PAUSED", amount: 1, endsAt: new Date(0), views: 999 });
      expect(res.status).toBe(200);
      const b = res.body.booking;
      expect([b.title, b.description, b.product, b.status, b.amount, b.views]).toEqual(["New title", "A brand new description.", String(products[1]._id), "LIVE", 5000, 0]);
      expect(new Date(b.endsAt).getTime()).toBe(new Date(booked.endsAt).getTime());
      const [live] = await hero();
      expect([live.title, live.description, String(live.product._id || live.product.id), live.id]).toEqual(["New title", "A brand new description.", String(products[1]._id), booked.bookingNumber]);
      expect(await AdBooking.countDocuments({})).toBe(1); // edited in place, not duplicated
    });

    test("an edit is checked like a booking, and changing nothing is refused", async () => {
      const id = (await book("seller")).body.booking.id;
      expect((await edit("seller", id, { title: "x" })).status).toBe(400);
      expect((await edit("seller", id, { description: "y".repeat(1001) })).status).toBe(400);
      expect((await edit("seller", id, {})).status).toBe(400);
      expect((await edit("seller", id, { title: "Lamps that last" })).status).toBe(400); // same as now
      expect((await edit("seller", id, { productId: "nope" })).status).toBe(400);
      await Product.updateOne({ _id: products[2]._id }, { $set: { stockQuantity: 0 } });
      expect((await edit("seller", id, { productId: String(products[2]._id) })).status).toBe(400); // out of stock
      expect((await AdBooking.findById(id)).title).toBe("Lamps that last");
    });

    test("only the owner can edit or delete; buyers and other sellers are refused", async () => {
      const id = (await book("seller")).body.booking.id;
      expect((await edit("otherSeller", id, { title: "Hijacked" })).status).toBe(404);
      expect((await del("otherSeller", id)).status).toBe(404);
      expect((await edit("buyer", id, { title: "Hijacked" })).status).toBe(403);
      expect((await del("buyer", id)).status).toBe(403);
      expect((await edit("seller", "nope", { title: "Hello there" })).status).toBe(404);
      expect((await request(app).patch(`/api/ad-bookings/${id}`).send({ title: "Anon title" })).status).toBe(401);
      expect((await AdBooking.findById(id)).title).toBe("Lamps that last");
      expect((await hero()).length).toBe(1);
    });

    test("another seller's product can't be swapped in", async () => {
      const id = (await book("seller")).body.booking.id;
      const category = await Category.findOne({});
      const theirs = await Product.create({ vendor: otherSeller._id, category: category._id, name: "Theirs", description: "Theirs.", price: 100, stockQuantity: 3, status: "ACTIVE", media: { mainImage: "/t.png", gallery: [] } });
      expect((await edit("seller", id, { productId: String(theirs._id) })).status).toBe(400);
    });

    test("a paused ad stays paused when edited; ended, rejected or removed ads can't be edited", async () => {
      const id = (await book("seller")).body.booking.id;
      await request(app).post(`/api/ad-bookings/${id}/deactivate`).set(as("admin"));
      const res = await edit("seller", id, { title: "Better title" });
      expect([res.status, res.body.booking.status, res.body.booking.title]).toEqual([200, "PAUSED", "Better title"]);
      expect((await hero()).length).toBe(0); // editing did not bypass Ikiguzi's pause
      await request(app).post(`/api/ad-bookings/${id}/remove`).set(as("admin")).send({ reason: "Not allowed here" });
      expect((await edit("seller", id, { title: "Back again" })).status).toBe(409);
      expect((await del("seller", id)).status).toBe(409);
    });

    test("deleting a live ad takes it off the banner at once, earns the fee and refunds nothing", async () => {
      const b = (await book("seller")).body.booking;
      expect((await hero()).length).toBe(1);
      const res = await del("seller", b.id);
      expect([res.status, res.body.booking.status]).toEqual([200, "ENDED"]);
      expect((await hero()).length).toBe(0);
      expect(await feeEntries(b)).toBe(1);
      expect(await Disbursement.countDocuments({})).toBe(0);
      expect((await del("seller", b.id)).status).toBe(409); // already gone: no second fee
      expect(await feeEntries(b)).toBe(1);
      const mine = (await request(app).get("/api/ad-bookings/mine").set(as("seller"))).body.bookings;
      expect(mine.map((m) => m.status)).toEqual(["ENDED"]); // the record stays
    });

    test("deleting an ad that is still waiting for payment cancels it", async () => {
      const b = await AdBooking.create({ bookingNumber: "ADB-WAIT-001", seller: seller._id, sellerRole: "vendor", product: products[0]._id, products: [{ id: String(products[0]._id), name: "Lamp", image: "/x.png" }], title: "Waiting ad", description: "Not paid yet.", displaySeconds: 5, pricePerProduct: 5000, amount: 5000, days: 7, paymentMethod: "MOMO", status: "AWAITING_PAYMENT" });
      const res = await del("seller", String(b._id));
      expect([res.status, res.body.booking.status]).toEqual([200, "CANCELLED"]);
    });
  });
});
