// Automatic payouts (services/autoPayout.service.js).
//   GET /api/auto-payouts        → the signed-in user's setting
//   PUT /api/auto-payouts        { auto, phone, accountName }
const express = require("express");
const autoPayout = require("../services/autoPayout.service");
const { protect, authorize } = require("../middleware/auth.middleware");
const { write } = require("../middleware/rateLimits");

const router = express.Router();
const run = (fn) => async (req, res) => {
  try {
    return res.status(200).json(await fn(req));
  } catch (error) {
    if (!error.statusCode) console.error("Auto payouts:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "We couldn't save your payout setting. Please try again." });
  }
};

router.use(protect, authorize("vendor", "supplier", "delivery", "affiliate"));
router.get("/", run((req) => autoPayout.get(req.user)));
router.put("/", write, run(async (req) => ({
  message: req.body?.auto ? "Your money will be sent to this number automatically after each delivery." : "Saved. You withdraw your money yourself.",
  setting: await autoPayout.set(req.user, req.body || {}),
})));

module.exports = router;
