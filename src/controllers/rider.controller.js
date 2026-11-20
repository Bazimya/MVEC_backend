// Ikiguzi riders (/api/rider): sign-up, going online, offers and trips.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const orm = require("../database/orm");
const User = require("../models/User");
const deliveryService = require("../services/delivery.service");
const trackingService = require("../services/tracking.service");
const { normalizePhone, phoneVariants } = require("../utils/sms.util");
const { signToken, getAuthenticatedUserResponse } = require("./auth.controller");

const sendError = (res, error) => {
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message, code: error.code });
  console.error(error);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
};
const run = (fn, status = 200) => async (req, res) => {
  try {
    if (req.params.id && !orm.isValidObjectId(req.params.id)) return res.status(404).json({ message: "This delivery no longer exists." });
    return res.status(status).json(await fn(req));
  } catch (error) {
    return sendError(res, error);
  }
};

// @route POST /api/rider/register   { verificationToken, fullName, vehicleType, plateNumber, email? }
// The phone was verified with POST /api/auth/verify-otp (purpose "registration", role "delivery").
// The account can sign in at once; it takes deliveries once an admin approves it.
exports.register = async (req, res) => {
  try {
    // Without SMS (config/phoneCodes.js) riders give their phone directly and
    // must choose a password, since they can't sign in with a code.
    const codes = require("../config/phoneCodes").required();
    let phone;
    if (codes || req.body.verificationToken) {
      let decoded;
      try {
        decoded = jwt.verify(String(req.body.verificationToken || ""), process.env.JWT_SECRET);
      } catch {
        return res.status(400).json({ message: "Your phone check expired. Verify your phone again." });
      }
      phone = decoded.purpose === "registration" && decoded.role === "delivery" ? normalizePhone(decoded.phone) : null;
      if (!phone) return res.status(400).json({ message: "Verify your phone as a rider first." });
    } else {
      phone = normalizePhone(req.body.phone);
      if (!phone) return res.status(400).json({ message: "Enter a valid Rwandan phone number (e.g. 0788123456)." });
      if (typeof req.body.password !== "string" || req.body.password.length < 8) {
        return res.status(400).json({ message: "Choose a password of at least 8 characters. You'll sign in with it." });
      }
    }
    const fullName = String(req.body.fullName || "").trim();
    if (fullName.length < 3) return res.status(400).json({ message: "Enter your full name." });
    if (await User.findOne({ phone: { $in: phoneVariants(phone) } }).lean()) {
      return res.status(409).json({ message: "This phone number already has an Ikiguzi account. Sign in instead." });
    }
    const email = String(req.body.email || "").trim().toLowerCase() || undefined;
    // Riders choose a password, so they can sign in with phone + password like
    // everyone else (a phone code still works too).
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (password && password.length < 8) return res.status(400).json({ message: "Choose a password of at least 8 characters." });
    const user = await User.create({
      Fullname: fullName, phone: `0${phone.slice(4)}`, email, role: "delivery", isOnboarded: true,
      // Without one (older apps), an unusable random password: they set theirs later from their profile.
      password: await bcrypt.hash(password || crypto.randomBytes(32).toString("hex"), 10),
      lastPasswordChangeAt: password ? new Date() : null,
    });
    await deliveryService.register(user, req.body);
    return res.status(201).json({
      message: "You're signed up. Ikiguzi will review your details and tell you when you can start.",
      token: signToken(user._id),
      user: await getAuthenticatedUserResponse(user),
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "This email or phone is already used by another account." });
    return sendError(res, error);
  }
};

exports.me = run((req) => deliveryService.profile(req.user));
exports.location = run((req) => deliveryService.updateLocation(req.user, req.body));
exports.availability = run((req) => deliveryService.setAvailability(req.user, req.body));
exports.area = run((req) => deliveryService.setArea(req.user, req.body));
exports.available = run((req) => deliveryService.listAvailable(req.user));
exports.active = run((req) => deliveryService.active(req.user));
exports.offer = run((req) => deliveryService.offerFor(req.user, req.params.id));
exports.history = run((req) => deliveryService.history(req.user, req.query));
exports.stats = run((req) => deliveryService.stats(req.user));
exports.wallet = run((req) => deliveryService.wallet(req.user));
exports.accept = run((req) => deliveryService.accept(req.user, req.params.id));
exports.reject = run((req) => deliveryService.reject(req.user, req.params.id));
exports.release = run((req) => deliveryService.release(req.user, req.params.id));
exports.status = run((req) => deliveryService.updateStatus(req.user, req.params.id, req.body));
exports.confirm = run((req) => deliveryService.confirm(req.user, req.params.id, req.body));
exports.navigation = run((req) => trackingService.riderNavigation(req.user, req.params.id));
// Buyers, sellers and admins: where the riders carrying an order's parcels are.
exports.orderLive = async (req, res) => {
  if (!orm.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Order not found." });
  try {
    return res.json(await trackingService.orderLive(req.user, req.params.id, { vendorId: req.vendorId }));
  } catch (error) {
    return sendError(res, error);
  }
};

// Admin: review riders.
exports.adminList = run((req) => deliveryService.listRiders(req.query));
exports.adminReview = run((req) => deliveryService.reviewRider(req.params.id, req.body));
exports.adminDeliveries = run(() => trackingService.activeDeliveries());
exports.adminRelease = run((req) => deliveryService.adminRelease(req.params.id, req.body));
