"use strict";

// Supplier stores get a pickup pin and rider delivery (copied to the
// supplier's buyer-facing shop), and riders say which district they work in.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const pin = { type: S.DECIMAL(9, 6), allowNull: true };
    await queryInterface.addColumn("supplier_stores", "pickupLat", pin);
    await queryInterface.addColumn("supplier_stores", "pickupLng", pin);
    await queryInterface.addColumn("supplier_stores", "riderDelivery", { type: S.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("riders", "province", { type: S.STRING(60), allowNull: true });
    await queryInterface.addColumn("riders", "district", { type: S.STRING(60), allowNull: true });
  },

  async down(queryInterface) {
    for (const [table, column] of [["riders", "district"], ["riders", "province"], ["supplier_stores", "riderDelivery"], ["supplier_stores", "pickupLng"], ["supplier_stores", "pickupLat"]]) {
      await queryInterface.removeColumn(table, column);
    }
  },
};
