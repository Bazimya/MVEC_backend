// Phone codes (SMS one-time codes) for guest checkout, "follow my order" and
// rider sign-up. They are required only when a real SMS provider is set up
// (Pindo or Africa's Talking), or with PHONE_CODES=on; PHONE_CODES=off turns
// them off. Without codes:
//   - guests check out with their phone number alone (never into an account
//     that has a password: those sign in);
//   - "follow my order" needs the phone and the order number;
//   - riders sign up without a code and sign in with their password.
function required() {
  const flag = String(process.env.PHONE_CODES || "").trim().toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return ["pindo", "africastalking"].includes(require("../services/messaging.service").smsProvider() || "");
}

module.exports = { required };
