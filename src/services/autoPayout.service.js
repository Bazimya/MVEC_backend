// Automatic payouts. At delivery, financial.service.releaseEscrowToVendor
// splits each sale: Ikiguzi's commission, the affiliate's commission and the
// payment fee go to their own accounts, and the seller's share becomes their
// available balance. With "send automatically" on, that balance is sent to the
// owner's mobile money number without a withdrawal request: sellers,
// suppliers and riders (VendorWallet) from 1,000 RWF, affiliates
// (AffiliateWallet) from their 10,000 RWF minimum. The worker runs every
// minute (workers/slaWorker.js); a failed transfer returns to the balance
// (disbursement.service) and is retried on a later run.
const crypto = require("crypto");
const PayoutPreference = require("../models/PayoutPreference");
const VendorWallet = require("../models/VendorWallet");
const AffiliateWallet = require("../models/AffiliateWallet");
const { Payout } = require("../models/Payout");
const User = require("../models/User");
const { formatRwandanPhone } = require("../utils/momo.util");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const idOf = (v) => String(v?._id || v?.id || v || "");
const WALLET_ROLES = ["vendor", "supplier", "delivery"];
const ROLES = [...WALLET_ROLES, "affiliate"];
const MIN_WALLET = 1000;
const MIN_AFFILIATE = 10000;
// After a failure, wait before trying again (the money is back in the balance).
const RETRY_AFTER_MS = 30 * 60 * 1000;

const minimumFor = (role) => (role === "affiliate" ? MIN_AFFILIATE : MIN_WALLET);

const view = (pref, role) => ({
  auto: Boolean(pref?.auto),
  method: pref?.method || "MTN_MOMO",
  phone: pref?.phone ? formatRwandanPhone(pref.phone)?.localNumber || pref.phone : "",
  accountName: pref?.accountName || "",
  lastSentAt: pref?.lastSentAt || null,
  lastError: pref?.lastError || "",
  minimum: minimumFor(role),
});

async function get(user) {
  if (!ROLES.includes(user.role)) throw httpError(403, "Automatic payouts are for sellers, suppliers, riders and affiliates.");
  return view(await PayoutPreference.findOne({ user: idOf(user) }).lean(), user.role);
}

/** { auto, phone, accountName } — the network is worked out from the number. */
async function set(user, { auto, phone, accountName } = {}) {
  if (!ROLES.includes(user.role)) throw httpError(403, "Automatic payouts are for sellers, suppliers, riders and affiliates.");
  const info = formatRwandanPhone(phone);
  if (!info) throw httpError(400, "Enter a Rwandan mobile money number: 078/079 (MTN) or 072/073 (Airtel).");
  const name = String(accountName || user.Fullname || "").trim().slice(0, 100);
  if (!name) throw httpError(400, "Enter the name on the mobile money account.");
  const fields = { auto: Boolean(auto), phone: info.formattedNumber, method: info.provider === "MTN" ? "MTN_MOMO" : "AIRTEL_MONEY", accountName: name, lastError: "" };
  let pref = await PayoutPreference.findOne({ user: idOf(user) });
  if (pref) {
    Object.assign(pref, fields);
    await pref.save();
  } else {
    pref = await PayoutPreference.create({ user: idOf(user), ...fields });
  }
  // Send what is already waiting straight away.
  if (pref.auto) await sendFor(pref, user).catch((e) => console.error("[Auto payout]", e.message));
  return view(await PayoutPreference.findById(pref._id).lean(), user.role);
}

/** Sends a VendorWallet owner's whole available balance. */
async function sendWallet(pref, user) {
  const current = await VendorWallet.findOne({ vendor: idOf(user) }).lean();
  const amount = Math.floor(Number(current?.availableBalance) || 0);
  if (amount < MIN_WALLET) return null;
  // Reserve first: fails if a manual withdrawal took the money meanwhile.
  const wallet = await VendorWallet.findOneAndUpdate(
    { vendor: idOf(user), availableBalance: { $gte: amount } },
    { $inc: { availableBalance: -amount } },
    { new: true },
  );
  if (!wallet) return null;
  const info = formatRwandanPhone(pref.phone);
  const prefix = user.role === "supplier" ? "SUP" : user.role === "delivery" ? "RID" : "PAY";
  let payout;
  try {
    payout = await Payout.create({
      vendor: idOf(user),
      payoutNumber: `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      amount,
      payoutMethod: info.provider === "MTN" ? "MOMO" : "AIRTEL",
      payoutDetails: { accountName: pref.accountName, accountNumber: info.formattedNumber, bankName: info.provider === "MTN" ? "MTN MoMo" : "Airtel Money" },
      status: "PROCESSING",
      note: "Sent automatically",
    });
    // From here the disbursement service owns the money (it returns it on final failure).
    await require("./disbursement.service").queue({
      kind: "VENDOR_PAYOUT", recipient: idOf(user), phone: info.formattedNumber, amount,
      vendorPayout: payout._id, idempotencyKey: `auto-payout:${payout._id}`,
    });
  } catch (error) {
    if (!payout) await VendorWallet.updateOne({ vendor: idOf(user) }, { $inc: { availableBalance: amount } });
    else await Payout.updateOne({ _id: payout._id }, { $set: { status: "FAILED", rejectionReason: "Could not be started." } }).then(() => VendorWallet.updateOne({ vendor: idOf(user) }, { $inc: { availableBalance: amount } }));
    throw error;
  }
  return { amount, payout: idOf(payout) };
}

async function sendAffiliate(pref, user) {
  const wallet = await AffiliateWallet.findOne({ affiliateUser: idOf(user) }).lean();
  const amount = Math.floor(Number(wallet?.availableBalance) || 0);
  if (amount < MIN_AFFILIATE) return null;
  const payout = await require("./affiliate.service").requestPayout({
    userId: idOf(user), amount, paymentMethod: pref.method, accountDetails: { phoneNumber: pref.phone, accountName: pref.accountName },
  });
  return { amount, payout: idOf(payout) };
}

async function sendFor(pref, user) {
  try {
    const sent = user.role === "affiliate" ? await sendAffiliate(pref, user) : WALLET_ROLES.includes(user.role) ? await sendWallet(pref, user) : null;
    if (sent) await PayoutPreference.updateOne({ _id: pref._id }, { $set: { lastSentAt: new Date(), lastError: "" } });
    return sent;
  } catch (error) {
    await PayoutPreference.updateOne({ _id: pref._id }, { $set: { lastError: String(error.message || "Could not send").slice(0, 300), lastSentAt: new Date() } });
    throw error;
  }
}

/** Worker: everyone with automatic payouts on and money waiting. */
async function runDue() {
  const prefs = await PayoutPreference.find({ auto: true }).limit(500);
  if (!prefs.length) return { sent: 0 };
  const users = await User.find({ _id: { $in: prefs.map((p) => p.user) } }).select("role status Fullname").lean();
  const byId = new Map(users.map((u) => [idOf(u), u]));
  let sent = 0;
  for (const pref of prefs) {
    const user = byId.get(idOf(pref.user));
    if (!user || ["BLOCK", "BLOCKED", "SUSPENDED"].includes(String(user.status || "").toUpperCase())) continue;
    // A recent failure waits before the next try.
    if (pref.lastError && pref.lastSentAt && Date.now() - new Date(pref.lastSentAt).getTime() < RETRY_AFTER_MS) continue;
    try {
      if (await sendFor(pref, user)) sent += 1;
    } catch (error) {
      console.error(`[Auto payout] ${idOf(user)}:`, error.message);
    }
  }
  return { sent };
}

module.exports = { get, set, runDue, MIN_WALLET, MIN_AFFILIATE };
