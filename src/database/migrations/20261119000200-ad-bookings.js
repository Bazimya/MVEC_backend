"use strict";

// "Advertise here": flat-fee ad bookings paid by mobile money, approved (or
// rejected and refunded) by Ikiguzi.
const ENTRY_TYPES = ["PAYMENT_ESCROW_LOCK", "ESCROW_RELEASE_VENDOR", "PLATFORM_COMMISSION_DEDUCTION", "COURIER_FEE_PAYOUT", "BUYER_REFUND", "ADMIN_MANUAL_ADJUSTMENT", "AFFILIATE_COMMISSION", "PAYMENT_RECEIVED", "PAYOUT_SENT", "AD_BUDGET_RESERVED", "AD_BUDGET_RETURNED", "AD_CLICK_REVENUE", "SUBSCRIPTION_FEE", "GATEWAY_FEE"];

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const now = { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") };
    await queryInterface.createTable("ad_bookings", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      bookingNumber: { type: S.STRING(40), allowNull: false, unique: true },
      sellerId: { type: S.CHAR(24), allowNull: false },
      sellerRole: { type: S.ENUM("vendor", "supplier", "super_admin"), allowNull: false, defaultValue: "vendor" },
      products: { type: S.JSON, allowNull: true },
      placement: { type: S.ENUM("HOMEPAGE_HERO"), allowNull: false, defaultValue: "HOMEPAGE_HERO" },
      pricePerProduct: { type: S.DECIMAL(14, 2), allowNull: false },
      amount: { type: S.DECIMAL(14, 2), allowNull: false },
      days: { type: S.INTEGER, allowNull: false, defaultValue: 7 },
      status: { type: S.ENUM("AWAITING_PAYMENT", "PAID", "LIVE", "REJECTED", "ENDED", "CANCELLED"), allowNull: false, defaultValue: "AWAITING_PAYMENT" },
      paymentId: { type: S.CHAR(24), allowNull: true },
      payerPhone: { type: S.STRING(30), allowNull: true },
      paidAt: { type: S.DATE, allowNull: true },
      startsAt: { type: S.DATE, allowNull: true },
      endsAt: { type: S.DATE, allowNull: true },
      reviewedById: { type: S.CHAR(24), allowNull: true },
      reviewedAt: { type: S.DATE, allowNull: true },
      rejectionReason: { type: S.STRING(500), allowNull: true },
      refundId: { type: S.CHAR(24), allowNull: true },
      createdAt: now,
      updatedAt: now,
    });
    await queryInterface.addIndex("ad_bookings", ["sellerId"]);
    await queryInterface.addIndex("ad_bookings", ["status"]);
    await queryInterface.changeColumn("ledger_entries", "entryType", { type: S.ENUM(...ENTRY_TYPES, "AD_PLACEMENT_FEE"), allowNull: false });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("ad_bookings");
    await queryInterface.changeColumn("ledger_entries", "entryType", { type: Sequelize.ENUM(...ENTRY_TYPES), allowNull: false });
  },
};
