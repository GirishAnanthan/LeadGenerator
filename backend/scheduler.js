/**
 * scheduler.js
 * 
 * Triggered nightly via GitHub Actions → POST /api/run-scheduler
 * Iterates all industry segments × all Indian states and scrapes
 * any combination not scraped in the past 30 days.
 */

const { scrapeLeads } = require('./scraper');
const { isDBConnected } = require('./db');
const ScrapeJob = require('./models/ScrapeJob');
const Segment = require('./models/Segment');

// Indian states to auto-scrape
const AUTO_SCRAPE_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Delhi', 'Chandigarh', 'Puducherry',
];

const COUNTRY = 'India';
const COUNTRY_CODE = 'IN';
const CACHE_AGE_DAYS = 30;
// Max jobs to run per scheduler invocation (prevents timeout on free tier)
const MAX_JOBS_PER_RUN = 5;

let schedulerRunning = false;

async function runScheduler(onStatusUpdate = console.log) {
  if (!isDBConnected()) {
    onStatusUpdate('[Scheduler] DB not connected — skipping.');
    return { skipped: true, reason: 'DB not connected' };
  }
  if (schedulerRunning) {
    onStatusUpdate('[Scheduler] Already running — skipping duplicate trigger.');
    return { skipped: true, reason: 'Already running' };
  }
  schedulerRunning = true;

  const results = { started: [], skipped: [] };

  try {
    // Get all segments (predefined + custom)
    const segments = await Segment.find({}).lean();
    const segmentNames = segments.map(s => s.name);

    onStatusUpdate(`[Scheduler] Found ${segmentNames.length} segments × ${AUTO_SCRAPE_STATES.length} states`);

    const staleDate = new Date(Date.now() - CACHE_AGE_DAYS * 24 * 60 * 60 * 1000);
    let jobsStarted = 0;

    for (const industry of segmentNames) {
      if (jobsStarted >= MAX_JOBS_PER_RUN) break;

      for (const state of AUTO_SCRAPE_STATES) {
        if (jobsStarted >= MAX_JOBS_PER_RUN) break;

        // Check if already scraped recently
        const existingJob = await ScrapeJob.findOne({
          industry,
          country: COUNTRY,
          state,
          city: '',
        });

        if (existingJob && existingJob.status === 'done' && existingJob.lastRunAt > staleDate) {
          results.skipped.push(`${industry} / ${state}`);
          continue;
        }

        // Mark as running
        await ScrapeJob.findOneAndUpdate(
          { industry, country: COUNTRY, state, city: '' },
          { industry, country: COUNTRY, state, city: '', status: 'running', errorMsg: '' },
          { upsert: true, new: true }
        );

        jobsStarted++;
        results.started.push(`${industry} / ${state}`);
        onStatusUpdate(`[Scheduler] Starting: ${industry} in ${state}`);

        // Run scrape in background (don't await — fire and forget per job)
        scrapeLeadsForJob(industry, state, onStatusUpdate).catch(err => {
          console.error(`[Scheduler] Job failed: ${industry}/${state}:`, err.message);
        });
      }
    }

    onStatusUpdate(`[Scheduler] Run complete. Started: ${results.started.length}, Skipped: ${results.skipped.length}`);
    return results;
  } catch (err) {
    console.error('[Scheduler] Error:', err.message);
    throw err;
  } finally {
    // Release lock after a delay (give background jobs time to start)
    setTimeout(() => { schedulerRunning = false; }, 60000);
  }
}

async function scrapeLeadsForJob(industry, state, onStatusUpdate) {
  const Lead = require('./models/Lead');
  let leadCount = 0;

  try {
    await scrapeLeads(
      { countryCode: COUNTRY_CODE, country: COUNTRY, state, city: '', industry, searchDepth: 'medium' },
      async (lead) => {
        // Save to DB
        try {
          await Lead.findOneAndUpdate(
            { companyName: lead.companyName, industry, country: COUNTRY, state },
            { ...lead, industry, country: COUNTRY, state, city: '', scrapedAt: new Date() },
            { upsert: true, new: true }
          );
          leadCount++;
        } catch (e) {
          // Duplicate key or validation error — ignore
        }
      },
      (status) => onStatusUpdate(`[${industry}/${state}] ${status}`),
      () => false // never cancel scheduler jobs
    );

    await ScrapeJob.findOneAndUpdate(
      { industry, country: COUNTRY, state, city: '' },
      { status: 'done', leadCount, lastRunAt: new Date(), errorMsg: '' }
    );

    // Update segment lead count
    await Segment.findOneAndUpdate(
      { name: industry },
      { $inc: { leadCount } }
    );

    onStatusUpdate(`[Scheduler] Done: ${industry} in ${state} — ${leadCount} leads saved.`);
  } catch (err) {
    await ScrapeJob.findOneAndUpdate(
      { industry, country: COUNTRY, state, city: '' },
      { status: 'failed', errorMsg: err.message }
    );
    throw err;
  }
}

module.exports = { runScheduler };
