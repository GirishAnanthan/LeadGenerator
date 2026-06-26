const mongoose = require('mongoose');

const scrapeJobSchema = new mongoose.Schema(
  {
    industry:    { type: String, required: true, trim: true },
    country:     { type: String, default: '', trim: true },
    state:       { type: String, default: '', trim: true },
    city:        { type: String, default: '', trim: true },
    status:      { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    leadCount:   { type: Number, default: 0 },
    lastRunAt:   { type: Date, default: null },
    errorMsg:    { type: String, default: '' },
  },
  { timestamps: true }
);

// Unique per segment+location so we never queue the same job twice
scrapeJobSchema.index(
  { industry: 1, country: 1, state: 1, city: 1 },
  { unique: true }
);

module.exports = mongoose.model('ScrapeJob', scrapeJobSchema);
