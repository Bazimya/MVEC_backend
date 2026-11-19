require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");

jest.setTimeout(90000);

// Riders choose a password at sign-up and sign in like everyone else.
describe("Rider passwords", () => {
  let app;
  const secret = "rider_password_secret";
  const phoneCheck = (phone) => jwt.sign({ purpose: "registration", role: "delivery", phone }, secret, { expiresIn: "10m" });

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/auth", require("../../src/routes/auth.routes"));
    app.use("/api/rider", require("../../src/routes/rider.routes"));
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  const signUp = (body) => request(app).post("/api/rider/register").send({ fullName: "Jean Rider", vehicleType: "BICYCLE", ...body });

  test("a rider signs up with a password and signs in with phone and password", async () => {
    expect((await signUp({ verificationToken: phoneCheck("+250788111222"), password: "short" })).status).toBe(400);
    const res = await signUp({ verificationToken: phoneCheck("+250788111222"), password: "riding-safe-1" });
    expect(res.status).toBe(201);
    const login = await request(app).post("/api/auth/login").send({ phone: "0788111222", password: "riding-safe-1" });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("delivery");
  });

  test("a rider who signed up with a code only can set a first password", async () => {
    const res = await signUp({ verificationToken: phoneCheck("+250788333444") });
    expect(res.status).toBe(201);
    const token = res.body.token;
    const set = await request(app).post("/api/auth/change-password").set({ Authorization: `Bearer ${token}` }).send({ newPassword: "my-new-pass" });
    expect(set.status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ phone: "0788333444", password: "my-new-pass" })).status).toBe(200);
    // Only once: now the current password is needed.
    const again = await request(app).post("/api/auth/change-password").set({ Authorization: `Bearer ${set.body.token}` }).send({ newPassword: "another-pass" });
    expect(again.status).toBe(400);
    expect(Boolean((await User.findOne({ phone: "0788333444" })).lastPasswordChangeAt)).toBe(true);
  });
});
