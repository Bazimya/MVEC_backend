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

// "Advertise here": banner time is priced per second (5,000 RWF = 3 seconds,
// +1,000 RWF per extra second); the server prices it, a verified payment moves
// the booking to PAID, and Ikiguzi approves it before it shows.
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

  describe("pricing, bought time and validation", () => {
    test("5,000 RWF is 3 seconds; 12,000 is 10; 22,000 is 20 (by seconds or by amount)", async () => {
      const cases = [[{ seconds: 3 }, 5000, 3], [{ seconds: 10 }, 12000, 10], [{ seconds: 20 }, 22000, 20], [{ seconds: undefined, amount: 12000 }, 12000, 10], [{ seconds: undefined, amount: 22000 }, 22000, 20], [{ seconds: undefined, amount: 5000 }, 5000, 3]];
      for (const [extra, amount, seconds] of cases) {
        await AdBooking.deleteMany({});
        const res = await book("seller", ad(extra));
        expect(res.status).toBe(200);
        expect([res.body.booking.amount, res.body.booking.displaySeconds, res.body.booking.paymentMethod]).toEqual([amount, seconds, "MOMO"]);
      }
    });

    test("invalid amounts and seconds are rejected and nothing is booked", async () => {
      const bad = [{ seconds: undefined, amount: 4000 }, { seconds: undefined, amount: 0 }, { seconds: undefined, amount: 5500 }, { seconds: undefined, amount: -5000 }, { seconds: 2 }, { seconds: 0 }, { seconds: 3.5 }, { seconds: 999 }, { seconds: 10, amount: 5000 }, { seconds: undefined, amount: undefined }];
      for (const extra of bad) {
        const res = await book("seller", ad(extra));
        expect(res.status).toBe(400);
      }
      expect(await AdBooking.countDocuments({})).toBe(0);
      expect(await Payment.countDocuments({})).toBe(0);
    });

    test("what the client sends about status, payment or seconds is ignored", async () => {
      const res = await book("seller", ad({ seconds: 3, displaySeconds: 60, status: "LIVE", paymentStatus: "SUCCESS", amount: undefined, days: 999, startsAt: new Date() }));
      expect(res.status).toBe(200);
      expect([res.body.booking.displaySeconds, res.body.booking.status, res.body.booking.amount]).toEqual([3, "PAID", 5000]);
      expect(res.body.booking.days).toBe(7);
      expect(await hero()).toEqual([]);
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
      expect([p.basePrice, p.baseSeconds, p.extraSecondPrice, p.days]).toEqual([5000, 3, 1000, 7]);
      expect(p.ladder.find((r) => r.seconds === 10).amount).toBe(12000);
      const q = await request(app).get("/api/ad-bookings/quote?amount=22000");
      expect([q.body.seconds, q.body.amount]).toEqual([20, 22000]);
      expect((await request(app).get("/api/ad-bookings/quote?amount=4500")).status).toBe(400);
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
    test("buyers can't advertise; a paid ad shows only after Ikiguzi approves it, with its title, description and seconds", async () => {
      expect((await book("buyer")).status).toBe(403);
      const res = await book("seller", ad({ seconds: 10 }));
      expect([res.body.booking.status, res.body.booking.paymentStatus, res.body.booking.amount]).toEqual(["PAID", "SUCCESS", 12000]);

      expect(await hero()).toEqual([]); // paid is not live
      const attention = await request(app).get("/api/admin/attention").set(as("admin"));
      expect(attention.body.items.find((i) => i.key === "adBookings").count).toBe(1);
      expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/approve`).set(as("seller"))).status).toBe(403);

      const ok = await approve(res.body.booking.id);
      expect(ok.body.booking.status).toBe("LIVE");
      const [slide] = await hero();
      expect([slide.product.name, slide.title, slide.description, slide.displaySeconds]).toEqual(["Lamp", "Lamps that last", "Warm light for every room in the house.", 10]);
      expect(new Date(ok.body.booking.endsAt) > new Date()).toBe(true);
    });

    test("every ad keeps its own purchased seconds", async () => {
      for (const [i, seconds] of [3, 10, 20].entries()) {
        const b = await book("seller", ad({ productId: String(products[i]._id), seconds }));
        await approve(b.body.booking.id);
      }
      const bySeconds = Object.fromEntries((await hero()).map((s) => [s.product.name, s.displaySeconds]));
      expect(bySeconds).toEqual({ Lamp: 3, Chair: 10, Mat: 20 });
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

    test("approving twice at once earns the fee once", async () => {
      const b = await book("seller", ad());
      const [a, c] = await Promise.all([approve(b.body.booking.id), approve(b.body.booking.id)]);
      expect([a.status, c.status].sort()).toEqual([200, 409]);
      expect(await feeEntries(b.body.booking)).toBe(1);
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
      expect((await AdBooking.findById(booking._id)).status).toBe("PAID");
      // Even calling the fulfilment step directly again changes nothing.
      expect(await adBookings.markPaid(await Payment.findById(payment._id))).toBeNull();
      const ledgerIn = await LedgerEntry.countDocuments({ transactionReference: booking.bookingNumber, entryType: "PAYMENT_RECEIVED" });
      expect(ledgerIn).toBe(1);
      // PAID is still not on the banner.
      expect(await hero()).toEqual([]);
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

    test("money that still arrives after a cancel is not lost: the ad goes to PAID", async () => {
      const { booking, payment } = await waiting();
      await request(app).post(`/api/ad-bookings/${booking._id}/cancel`).set(as("seller"));
      await paymentService.settleGatewayPayment({ payment, provider: "PAYPACK", status: "SUCCESSFUL", amount: 12000 });
      const paid = await AdBooking.findById(booking._id);
      expect([paid.status, paid.paymentStatus]).toEqual(["PAID", "SUCCESS"]);
    });
  });

  test("a rejected booking is refunded to the number that paid", async () => {
    const res = await book("seller", ad({ seconds: 5 }));
    expect((await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "no" })).status).toBe(400);
    const rejected = await request(app).post(`/api/ad-bookings/${res.body.booking.id}/reject`).set(as("admin")).send({ reason: "The photo is blurry." });
    expect(rejected.body.booking.status).toBe("REJECTED");
    const refund = await Disbursement.findOne({ idempotencyKey: `ad-booking-refund:${res.body.booking.id}` });
    expect([refund.kind, Number(refund.amount)]).toEqual(["REFUND", 7000]);
    expect(refund.phone).toContain("788123456");
    // Can't approve it afterwards, and it never shows.
    expect((await approve(res.body.booking.id)).status).toBe(409);
    expect(await hero()).toEqual([]);
  });

  test("sellers see their own ads with the payment state", async () => {
    await book("seller", ad({ seconds: 4 }));
    const mine = await request(app).get("/api/ad-bookings/mine").set(as("seller"));
    expect(mine.body.bookings.length).toBe(1);
    expect([mine.body.bookings[0].paymentLabel, mine.body.bookings[0].statusLabel]).toEqual(["Payment successful", "Paid: Ikiguzi is reviewing it"]);
    expect((await request(app).get("/api/ad-bookings/mine").set(as("otherSeller"))).body.bookings).toEqual([]);
    const admin1 = await request(app).get("/api/ad-bookings/admin?status=PAID").set(as("admin"));
    expect(admin1.body.bookings[0].sellerName).toBe("Kigali Shop");
    expect((await request(app).get("/api/ad-bookings/admin").set(as("seller"))).status).toBe(403);
  });

  test("riders waiting for approval show in Needs your attention", async () => {
    const riderUser = await User.create({ Fullname: "New Rider", email: "r@example.com", password: "password123", phone: "0788000899", gender: "male", role: "delivery", isOnboarded: true });
    await Rider.create({ user: riderUser._id, vehicleType: "MOTORBIKE", plateNumber: "RAB111A", status: "PENDING" });
    const attention = await request(app).get("/api/admin/attention").set(as("admin"));
    const riders = attention.body.items.find((i) => i.key === "riders");
    expect([riders.count, riders.link]).toEqual([1, "/admin/riders"]);
    expect(attention.body.badges["/admin/riders"]).toBe(1);
  });
});
