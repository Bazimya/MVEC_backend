// "Advertise here" bookings (services/adBooking.service.js).
const express = require("express");
const bookings = require("../services/adBooking.service");
const { protect, authorize } = require("../middleware/auth.middleware");
const { write } = require("../middleware/rateLimits");

const router = express.Router();
const run = (fn) => async (req, res) => {
  try {
    return res.status(200).json(await fn(req));
  } catch (error) {
    if (!error.statusCode) console.error("Ad bookings:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Something went wrong with the ad booking. Please try again." });
  }
};

// Public: what it costs.
router.get("/pricing", run(() => bookings.pricing()));

router.use(protect);
router.get("/mine", run((req) => bookings.mine(req.user)));
router.post("/", write, run((req) => bookings.create(req.user, req.body || {})));

// Ikiguzi
router.get("/admin", authorize("super_admin"), run((req) => bookings.forAdmin(req.query)));
router.post("/:id/approve", authorize("super_admin"), run((req) => bookings.approve(req.user, req.params.id)));
router.post("/:id/reject", authorize("super_admin"), run((req) => bookings.reject(req.user, req.params.id, req.body || {})));

module.exports = router;
