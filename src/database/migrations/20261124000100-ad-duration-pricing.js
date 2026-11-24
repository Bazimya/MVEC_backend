"use strict";

// Home banner ads are now priced by the seconds they show (utils/adPricing.js)
// and carry the seller's own title and description. Backward compatible: every
// column is new and nullable (or has a default), and existing bookings keep
// working. They have no displaySeconds, so the banner uses its default time.
//
//   - title, description: the banner's big text and the smaller line under it
//   - productId: the one advertised product (also still in `products`)
//   - displaySeconds: banner time bought; the server sets it, never the client
//   - paymentMethod, paymentStatus: how it was paid and what the gateway said
//   - status gains PAUSED (admin switched it off) and REMOVED (admin took it down)
const STATUSES = ["AWAITING_PAYMENT", "PAID", "LIVE", "REJECTED", "ENDED", "CANCELLED"];

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const table = "ad_bookings";
    await queryInterface.addColumn(table, "title", { type: S.STRING(120), allowNull: true });
    await queryInterface.addColumn(table, "description", { type: S.STRING(1000), allowNull: true });
    await queryInterface.addColumn(table, "productId", { type: S.CHAR(24), allowNull: true });
    await queryInterface.addColumn(table, "displaySeconds", { type: S.INTEGER, allowNull: true });
    await queryInterface.addColumn(table, "paymentMethod", { type: S.ENUM("MOMO", "AIRTEL"), allowNull: true });
    await queryInterface.addColumn(table, "paymentStatus", { type: S.ENUM("PENDING", "SUCCESS", "FAILED", "CANCELLED"), allowNull: false, defaultValue: "PENDING" });
    await queryInterface.changeColumn(table, "status", { type: S.ENUM(...STATUSES, "PAUSED", "REMOVED"), allowNull: false, defaultValue: "AWAITING_PAYMENT" });

    // Bookings from before: whatever got past AWAITING_PAYMENT was paid.
    await queryInterface.sequelize.query(
      "UPDATE `ad_bookings` SET paymentStatus = 'SUCCESS' WHERE paidAt IS NOT NULL OR status IN ('PAID', 'LIVE', 'ENDED', 'REJECTED')",
    );
    await queryInterface.sequelize.query("UPDATE `ad_bookings` SET paymentStatus = 'CANCELLED' WHERE status = 'CANCELLED' AND paidAt IS NULL");
    await queryInterface.sequelize.query("UPDATE `ad_bookings` SET productId = JSON_UNQUOTE(JSON_EXTRACT(products, '$[0].id')) WHERE productId IS NULL AND JSON_LENGTH(products) = 1");

    await queryInterface.addIndex(table, ["productId"]);
    await queryInterface.addIndex(table, ["status", "endsAt"], { name: "ad_bookings_status_endsAt" });
    await queryInterface.addIndex(table, ["paymentId"]);
  },

  async down(queryInterface, Sequelize) {
    const table = "ad_bookings";
    await queryInterface.removeIndex(table, "ad_bookings_status_endsAt");
    await queryInterface.removeIndex(table, ["productId"]);
    await queryInterface.removeIndex(table, ["paymentId"]);
    // Rows in the new statuses go back to the nearest old one before the ENUM shrinks.
    await queryInterface.sequelize.query("UPDATE `ad_bookings` SET status = 'ENDED' WHERE status IN ('PAUSED', 'REMOVED')");
    await queryInterface.changeColumn(table, "status", { type: Sequelize.ENUM(...STATUSES), allowNull: false, defaultValue: "AWAITING_PAYMENT" });
    for (const column of ["paymentStatus", "paymentMethod", "displaySeconds", "productId", "description", "title"]) {
      await queryInterface.removeColumn(table, column);
    }
  },
};
