const mongoose = require('mongoose');

const segmentSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, unique: true, trim: true },
    isCustom:    { type: Boolean, default: false },
    addedByIp:   { type: String, default: '' },
    leadCount:   { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Segment', segmentSchema);
