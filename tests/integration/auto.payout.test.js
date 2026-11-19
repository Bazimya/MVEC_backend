require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const VendorWallet = require("../../src/models/VendorWallet");
const AffiliateWallet = require("../../src/models/AffiliateWallet");
const { Payout } = require("../../src/models/Payout");
const Disbursement = require("../../src/models/Disbursement");
const autoPayout = require("../../src/services/autoPayout.service");

jest.setTimeout(90000);

// Released money goes to the owner's mobile money without a withdrawal request.
describe("Automatic payouts", () => {
  let app, seller, buyer, affiliate;
  const tokens = {};
  const secret = "auto_payout_secret";
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox: transfers succeed at once
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/auto-payouts", require("../../src/routes/autoPayout.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880009${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    seller = await make("Kigali Shop", "vendor", 1);
    buyer = await make("Aline Buyer", "buyer", 2);
    affiliate = await make("Promo Person", "affiliate", 3);
    for (const [k, u] of Object.entries({ seller, buyer, affiliate })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  test("buyers have no payouts; a bad number is refused", async () => {
    expect((await request(app).get("/api/auto-payouts").set(as("buyer"))).status).toBe(403);
    const res = await request(app).put("/api/auto-payouts").set(as("seller")).send({ auto: true, phone: "12345", accountName: "Kigali Shop" });
    expect(res.status).toBe(400);
  });

  test("turning it on sends the available balance; later releases go on the next run", async () => {
    await VendorWallet.create({ vendor: seller._id, availableBalance: 4500, pendingBalance: 0, totalEarned: 4500 });
    const res = await request(app).put("/api/auto-payouts").set(as("seller")).send({ auto: true, phone: "0788123456", accountName: "Kigali Shop" });
    expect(res.status).toBe(200);
    expect([res.body.setting.auto, res.body.setting.phone]).toEqual([true, "0788123456"]);
    let wallet = await VendorWallet.findOne({ vendor: seller._id }).lean();
    expect(Number(wallet.availableBalance)).toBe(0);
    const payouts = await Payout.find({ vendor: seller._id }).lean();
    expect(payouts.map((p) => [Number(p.amount), p.note])).toEqual([[4500, "Sent automatically"]]);
    expect(await Disbursement.countDocuments({ kind: "VENDOR_PAYOUT" })).toBe(1);

    // Below the minimum nothing is sent; above it the worker sends it.
    await VendorWallet.updateOne({ vendor: seller._id }, { $inc: { availableBalance: 800 } });
    expect((await autoPayout.runDue()).sent).toBe(0);
    await VendorWallet.updateOne({ vendor: seller._id }, { $inc: { availableBalance: 1200 } });
    expect((await autoPayout.runDue()).sent).toBe(1);
    wallet = await VendorWallet.findOne({ vendor: seller._id }).lean();
    expect(Number(wallet.availableBalance)).toBe(0);
  });

  test("off means the money stays for a manual withdrawal", async () => {
    await VendorWallet.create({ vendor: seller._id, availableBalance: 5000, pendingBalance: 0, totalEarned: 5000 });
    await request(app).put("/api/auto-payouts").set(as("seller")).send({ auto: false, phone: "0788123456", accountName: "Kigali Shop" });
    expect((await autoPayout.runDue()).sent).toBe(0);
    expect(Number((await VendorWallet.findOne({ vendor: seller._id }).lean()).availableBalance)).toBe(5000);
  });

  test("affiliates are paid from their 10,000 RWF minimum", async () => {
    await AffiliateWallet.create({ affiliateUser: affiliate._id, availableBalance: 9000, pendingBalance: 0 });
    await request(app).put("/api/auto-payouts").set(as("affiliate")).send({ auto: true, phone: "0731234567", accountName: "Promo Person" });
    expect(Number((await AffiliateWallet.findOne({ affiliateUser: affiliate._id }).lean()).availableBalance)).toBe(9000);
    await AffiliateWallet.updateOne({ affiliateUser: affiliate._id }, { $inc: { availableBalance: 2000 } });
    expect((await autoPayout.runDue()).sent).toBe(1);
    expect(Number((await AffiliateWallet.findOne({ affiliateUser: affiliate._id }).lean()).availableBalance)).toBe(0);
  });
});
