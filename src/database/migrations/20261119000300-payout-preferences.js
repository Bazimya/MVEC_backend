"use strict";

// Automatic payouts: where a seller, supplier, rider or affiliate wants their
// released money sent without asking.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const now = { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") };
    await queryInterface.createTable("payout_preferences", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      userId: { type: S.CHAR(24), allowNull: false, unique: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      auto: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      method: { type: S.ENUM("MTN_MOMO", "AIRTEL_MONEY"), allowNull: false, defaultValue: "MTN_MOMO" },
      phone: { type: S.STRING(30), allowNull: true },
      accountName: { type: S.STRING(100), allowNull: true },
      lastSentAt: { type: S.DATE, allowNull: true },
      lastError: { type: S.STRING(300), allowNull: true },
      createdAt: now,
      updatedAt: now,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("payout_preferences");
  },
};
