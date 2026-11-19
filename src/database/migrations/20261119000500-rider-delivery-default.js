"use strict";

// Ikiguzi riders become the default for every store with a pickup pin, and
// parcels remember which riders were woken for them and when the seller was
// told no rider took them yet.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    for (const table of ["stores", "supplier_stores"]) {
      await queryInterface.changeColumn(table, "riderDelivery", { type: S.BOOLEAN, allowNull: false, defaultValue: true });
      await queryInterface.sequelize.query(`UPDATE \`${table}\` SET riderDelivery = 1 WHERE pickupLat IS NOT NULL AND pickupLng IS NOT NULL`);
    }
    await queryInterface.addColumn("deliveries", "alerted", { type: S.JSON, allowNull: true });
    await queryInterface.addColumn("deliveries", "sellerAlertedAt", { type: S.DATE, allowNull: true });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("deliveries", "sellerAlertedAt");
    await queryInterface.removeColumn("deliveries", "alerted");
    for (const table of ["stores", "supplier_stores"]) {
      await queryInterface.changeColumn(table, "riderDelivery", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    }
  },
};
