"use strict";

// How a banner ad is used: times it was shown in the home banner and times a
// shopper pressed its Buy now or Description button. Counted by the banner
// (POST /api/ad-bookings/track) and shown to the seller. Backward compatible:
// new columns with a default of 0.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ad_bookings", "views", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("ad_bookings", "clicks", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ad_bookings", "clicks");
    await queryInterface.removeColumn("ad_bookings", "views");
  },
};
