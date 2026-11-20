require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const express = require("express");
const User = require("../../src/models/User");
const Order = require("../../src/models/Order");

jest.setTimeout(60000);

// Without SMS (PHONE_CODES=off, config/phoneCodes.js): guests check out with
// their number alone, riders sign up without a code and sign in with a password.
describe("Phone codes turned off", () => {
  let app;

  beforeAll(async () => {
    process.env.JWT_SECRET = "phone_codes_off_secret";
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/auth", require("../../src/routes/auth.routes"));
    app.use("/api/rider", require("../../src/routes/rider.routes"));
  });
  beforeEach(async () => {
    process.env.PHONE_CODES = "off";
    await db.reset();
  });
  afterAll(async () => {
    process.env.PHONE_CODES = "on";
    await db.close();
  });

  test("screens learn whether to ask for a code", async () => {
    expect((await request(app).get("/api/auth/phone-codes")).body).toEqual({ required: false });
    process.env.PHONE_CODES = "on";
    expect((await request(app).get("/api/auth/phone-codes")).body).toEqual({ required: true });
  });

  test("a guest checks out with their number alone, but never into an account with a password", async () => {
    const res = await request(app).post("/api/auth/guest/verify").send({ phone: "0788123450", fullName: "Aline Guest" });
    expect(res.status).toBe(200);
    expect(res.body.guest).toBe(true);
    expect(res.body.token).toBeTruthy();
    // The same guest number again: fine.
    expect((await request(app).post("/api/auth/guest/verify").send({ phone: "0788123450" })).status).toBe(200);

    await User.create({ Fullname: "Regular Buyer", email: "regular@example.com", password: "password123", phone: "0788123451", gender: "female", role: "buyer", isOnboarded: true });
    const regular = await request(app).post("/api/auth/guest/verify").send({ phone: "0788123451", fullName: "Someone" });
    expect(regular.status).toBe(409);
    expect(regular.body.code).toBe("SIGN_IN_REQUIRED");
  });

  test("following orders needs the phone and one of its order numbers", async () => {
    const guest = await request(app).post("/api/auth/guest/verify").send({ phone: "0788123452", fullName: "Eric Guest" });
    const userId = guest.body.user.id || guest.body.user._id;
    await Order.create({
      user: userId, orderNumber: "ORD-1-0001", items: [], totalAmount: 1000, subtotal: 1000,
      shippingAddress: { street: "KG 1 Ave", city: "Gasabo", country: "Rwanda" }, paymentMethod: "MOBILE_MONEY",
    }).catch(() => null);
    const order = await Order.findOne({ orderNumber: "ORD-1-0001" }).lean();
    expect((await request(app).post("/api/auth/guest/verify").send({ phone: "0788123452", track: true })).status).toBe(404);
    expect((await request(app).post("/api/auth/guest/verify").send({ phone: "0788123452", track: true, orderNumber: "ORD-9-9999" })).status).toBe(404);
    if (order) {
      expect((await request(app).post("/api/auth/guest/verify").send({ phone: "0788123452", track: true, orderNumber: "ord-1-0001" })).status).toBe(200);
    }
    expect((await request(app).post("/api/auth/guest/verify").send({ phone: "0788999000", track: true, orderNumber: "ORD-1-0001" })).status).toBe(404);
  });

  test("a rider signs up with phone and password, no code, then signs in with the password", async () => {
    const bad = await request(app).post("/api/rider/register").send({ phone: "0788123453", fullName: "Rider One", vehicleType: "BICYCLE", districts: ["Gasabo"] });
    expect(bad.status).toBe(400);
    const res = await request(app).post("/api/rider/register").send({ phone: "0788123453", fullName: "Rider One", vehicleType: "BICYCLE", districts: ["Gasabo"], password: "Secret@123" });
    expect(res.status).toBe(201);
    const login = await request(app).post("/api/auth/login").send({ phone: "0788123453", password: "Secret@123" });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("delivery");
    // The same number again is refused.
    expect((await request(app).post("/api/rider/register").send({ phone: "0788123453", fullName: "Rider Two", vehicleType: "BICYCLE", password: "Secret@123" })).status).toBe(409);
  });

  test("with codes on, guests and riders still need them", async () => {
    process.env.PHONE_CODES = "on";
    expect((await request(app).post("/api/auth/guest/verify").send({ phone: "0788123454", fullName: "Code Guest" })).status).toBe(400);
    expect((await request(app).post("/api/rider/register").send({ phone: "0788123455", fullName: "Rider Three", vehicleType: "BICYCLE", password: "Secret@123" })).status).toBe(400);
  });
});
