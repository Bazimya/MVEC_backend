// Map helpers: street search (public: guests check out too) and the signed-in
// person's own position (services/myLocation.service.js).
const express = require("express");
const limits = require("../middleware/rateLimits");
const { protect } = require("../middleware/auth.middleware");
const geocode = require("../services/geocode.service");
const myLocation = require("../services/myLocation.service");

const router = express.Router();
const run = (fn) => async (req, res) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Something went wrong. Please try again." });
  }
};

// GET /api/geo/search?q=KG 11 Ave, Remera, Gasabo → { results: [{ label, lat, lng }] }
router.get("/search", limits.geocode, run(async (req) => ({ results: await geocode.search(req.query.q) })));
// POST /api/geo/me { lat, lng } → fills the account's empty pins.
router.post("/me", protect, run((req) => myLocation.save(req.user, req.body)));

module.exports = router;
