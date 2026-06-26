const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema(
  {
    companyName:    { type: String, required: true, trim: true },
    industry:       { type: String, required: true, trim: true },
    country:        { type: String, default: '', trim: true },
    state:          { type: String, default: '', trim: true },
    city:           { type: String, default: '', trim: true },
    address:        { type: String, default: '' },
    contactPerson:  { type: String, default: '' },
    mobileNumber:   { type: String, default: '' },
    landlineNumber: { type: String, default: '' },
    emailId:        { type: String, default: '' },
    website:        { type: String, default: '' },
    socials:        { type: String, default: '' },
    description:    { type: String, default: '' },
    scrapedAt:      { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Unique per company+industry+location combination to prevent duplicates
leadSchema.index(
  { companyName: 1, industry: 1, country: 1, state: 1 },
  { unique: true }
);

// Fast lookups by segment + location
leadSchema.index({ industry: 1, country: 1, state: 1 });
leadSchema.index({ industry: 1 });

module.exports = mongoose.model('Lead', leadSchema);
