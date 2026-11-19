"use strict";

// Riders deliver in several districts; the one they chose before stays first.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("riders", "districts", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.sequelize.query("UPDATE riders SET districts = JSON_ARRAY(district) WHERE district IS NOT NULL");
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("riders", "districts");
  },
};
