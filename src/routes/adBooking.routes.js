// "Advertise here" bookings (services/adBooking.service.js).
const express = require("express");
const bookings = require("../services/adBooking.service");
const { protect, authorize } = require("../middleware/auth.middleware");
const { write, adTrack } = require("../middleware/rateLimits");

const router = express.Router();
const run = (fn) => async (req, res) => {
  try {
    return res.status(200).json(await fn(req));
  } catch (error) {
    if (!error.statusCode) console.error("Ad bookings:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Something went wrong with the ad booking. Please try again." });
  }
};

// Public: what it costs, what a given time or amount buys, and how it can be paid.
router.get("/pricing", run(() => bookings.pricing()));
router.get("/quote", run((req) => bookings.quote(req.query)));
router.get("/payment-methods", run(() => bookings.paymentMethods()));
// The banner reports views and clicks of live ads (public: shoppers may be signed out).
router.post("/track", adTrack, run((req) => bookings.track(req.body?.id, req.body?.event)));

router.use(protect);
router.get("/mine", run((req) => bookings.mine(req.user)));
router.post("/", write, run((req) => bookings.create(req.user, req.body || {})));
router.post("/:id/cancel", write, run((req) => bookings.cancel(req.user, req.params.id)));

// Ikiguzi
router.get("/admin", authorize("super_admin"), run((req) => bookings.forAdmin(req.query)));
router.post("/:id/approve", authorize("super_admin"), run((req) => bookings.approve(req.user, req.params.id)));
router.post("/:id/reject", authorize("super_admin"), run((req) => bookings.reject(req.user, req.params.id, req.body || {})));
router.post("/:id/deactivate", authorize("super_admin"), run((req) => bookings.deactivate(req.user, req.params.id)));
router.post("/:id/reactivate", authorize("super_admin"), run((req) => bookings.reactivate(req.user, req.params.id)));
router.post("/:id/remove", authorize("super_admin"), run((req) => bookings.remove(req.user, req.params.id, req.body || {})));

module.exports = router;
