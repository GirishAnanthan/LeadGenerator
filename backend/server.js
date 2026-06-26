const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { scrapeLeads } = require('./scraper');
const { connectDB, isDBConnected } = require('./db');

// Models — safe to require even if DB is not connected (mongoose handles it)
let Lead, Segment, ScrapeJob;
try {
  Lead = require('./models/Lead');
  Segment = require('./models/Segment');
  ScrapeJob = require('./models/ScrapeJob');
} catch (e) {
  console.warn('[server] Could not load models:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Predefined segments (seeded into DB on startup) ──────────────────────────
const PREDEFINED_SEGMENTS = [
  'IT & Software Companies',
  'Manufacturing Plants & Factories',
  'Healthcare & Hospitals',
  'Pharmaceutical Companies',
  'Real Estate Developers',
  'Construction Materials & Equipment',
  'Education & Training Institutes',
  'Finance, Banking & Insurance',
  'Retail & E-commerce Hubs',
  'Logistics & Supply Chain',
  'Food Processing & Beverage',
  'Textile & Garment Manufacturers',
  'Automotive & Auto Components',
  'Solar & Renewable Energy',
  'Chemical Industries',
  'Agriculture & Farming Equipment',
  'Solar EPC registered with MNRE',
  'Solar EPC not registered with MNRE',
  'Solar Project Developers',
  'Ceramic Tiles Manufacturers',
  'Vitrified Tiles Manufacturers',
  'Wall Tiles & Floor Tiles',
  'Sanitaryware & Bathroom Fittings',
  'Construction Materials & Building Products',
];

// ─── Cache age threshold ───────────────────────────────────────────────────────
const CACHE_MAX_AGE_DAYS = 30;

let currentBrowser = null;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:5173', 'http://localhost:4173'],
  methods: ['GET', 'POST'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '10kb' }));

const scrapeLimiter = rateLimit({
  windowMs: 60000,
  max: 5,
  message: { error: 'Too many requests. Please wait before starting another scrape.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Validation ────────────────────────────────────────────────────────────────
const VALID_DEPTHS = ['fast', 'medium', 'deep'];
const MAX_LOCATION_LENGTH = 100;
const MAX_INDUSTRY_LENGTH = 200;

function validateInput(body) {
  const errors = [];
  if (!body.industry || typeof body.industry !== 'string' || body.industry.trim().length === 0) {
    errors.push('Industry is required and must be a non-empty string.');
  } else if (body.industry.length > MAX_INDUSTRY_LENGTH) {
    errors.push(`Industry must be at most ${MAX_INDUSTRY_LENGTH} characters.`);
  }
  if (body.country && (typeof body.country !== 'string' || body.country.length > MAX_LOCATION_LENGTH)) {
    errors.push('Country is invalid.');
  }
  if (body.state && (typeof body.state !== 'string' || body.state.length > MAX_LOCATION_LENGTH)) {
    errors.push('State is invalid.');
  }
  if (body.city && (typeof body.city !== 'string' || body.city.length > MAX_LOCATION_LENGTH)) {
    errors.push('City is invalid.');
  }
  if (body.countryCode && (typeof body.countryCode !== 'string' || body.countryCode.length > 5)) {
    errors.push('Country code is invalid.');
  }
  if (body.searchDepth && !VALID_DEPTHS.includes(body.searchDepth)) {
    errors.push('Search depth must be one of: fast, medium, deep.');
  }
  return errors;
}

// ─── Helper: save a lead to DB ─────────────────────────────────────────────────
async function saveLeadToDB(lead, { industry, country, state, city }) {
  if (!isDBConnected() || !Lead) return;
  try {
    await Lead.findOneAndUpdate(
      { companyName: lead.companyName, industry, country, state },
      {
        ...lead,
        industry,
        country: country || '',
        state:   state   || '',
        city:    city    || '',
        scrapedAt: new Date(),
      },
      { upsert: true, new: true }
    );
  } catch (e) {
    // Duplicate key or validation — silently ignore
  }
}

// ─── Helper: mark scrape job done ──────────────────────────────────────────────
async function markJobDone(industry, country, state, city, leadCount) {
  if (!isDBConnected() || !ScrapeJob) return;
  try {
    await ScrapeJob.findOneAndUpdate(
      { industry, country, state, city },
      { status: 'done', leadCount, lastRunAt: new Date(), errorMsg: '' },
      { upsert: true }
    );
  } catch (e) { /* ignore */ }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), dbConnected: isDBConnected() });
});

// ── GET /api/segments ── return all segment names (predefined + custom from DB)
app.get('/api/segments', async (req, res) => {
  if (!isDBConnected() || !Segment) {
    // Fall back to hardcoded list
    return res.json({ segments: PREDEFINED_SEGMENTS.map(name => ({ name, isCustom: false })) });
  }
  try {
    const dbSegments = await Segment.find({}).sort({ isCustom: 1, name: 1 }).lean();
    return res.json({ segments: dbSegments.map(s => ({ name: s.name, isCustom: s.isCustom })) });
  } catch (e) {
    return res.json({ segments: PREDEFINED_SEGMENTS.map(name => ({ name, isCustom: false })) });
  }
});

// ── POST /api/segments ── add a custom segment
app.post('/api/segments', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Segment name is required.' });
  }
  const trimmed = name.trim().substring(0, MAX_INDUSTRY_LENGTH);

  if (!isDBConnected() || !Segment) {
    return res.json({ saved: false, reason: 'DB not connected' });
  }
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    await Segment.findOneAndUpdate(
      { name: trimmed },
      { name: trimmed, isCustom: true, addedByIp: ip.toString().substring(0, 45) },
      { upsert: true, new: true }
    );
    return res.json({ saved: true, name: trimmed });
  } catch (e) {
    return res.status(500).json({ error: 'Could not save segment.' });
  }
});

// ── GET /api/cache-check ── check if a query is already in the database
app.get('/api/cache-check', async (req, res) => {
  const { industry, country, state, city } = req.query;
  if (!industry || !country) {
    return res.status(400).json({ error: 'industry and country are required.' });
  }

  if (!isDBConnected() || !ScrapeJob || !Lead) {
    return res.json({ cached: false });
  }

  try {
    const job = await ScrapeJob.findOne({
      industry: industry.trim(),
      country:  (country || '').trim(),
      state:    (state   || '').trim(),
      city:     (city    || '').trim(),
    }).lean();

    const staleDate = new Date(Date.now() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const isFresh = job && job.status === 'done' && job.lastRunAt && new Date(job.lastRunAt) > staleDate;

    if (!isFresh) {
      return res.json({ cached: false });
    }

    const leadCount = await Lead.countDocuments({
      industry: industry.trim(),
      country:  (country || '').trim(),
      state:    (state   || '').trim(),
    });

    return res.json({
      cached:      leadCount > 0,
      leadCount,
      lastScraped: job.lastRunAt,
    });
  } catch (e) {
    return res.json({ cached: false });
  }
});

// ── GET /api/leads ── fetch cached leads (paginated)
app.get('/api/leads', async (req, res) => {
  const { industry, country, state, city, page = 1, limit = 200 } = req.query;
  if (!industry || !country) {
    return res.status(400).json({ error: 'industry and country are required.' });
  }
  if (!isDBConnected() || !Lead) {
    return res.status(503).json({ error: 'Database not connected.' });
  }

  try {
    const query = {
      industry: industry.trim(),
      country:  (country || '').trim(),
      state:    (state   || '').trim(),
    };

    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .sort({ companyName: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Lead.countDocuments(query),
    ]);

    return res.json({ leads, total, page: pageNum, limit: limitNum });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch leads.' });
  }
});

// ── POST /api/run-scheduler ── trigger background scraping (GitHub Actions cron)
app.post('/api/run-scheduler', async (req, res) => {
  const secret = process.env.SCHEDULER_SECRET;
  const provided = req.headers['x-scheduler-secret'] || req.body?.secret;
  if (secret && provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  res.json({ message: 'Scheduler triggered. Running in background.' });

  // Import lazily to avoid circular deps
  try {
    const { runScheduler } = require('./scheduler');
    runScheduler(console.log).catch(err => {
      console.error('[scheduler] Error:', err.message);
    });
  } catch (e) {
    console.error('[scheduler] Could not load scheduler module:', e.message);
  }
});

// ── Debug endpoint ─────────────────────────────────────────────────────────────
app.post('/api/debug-maps', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('google.com/maps')) {
    return res.status(400).json({ error: 'Provide a Google Maps place URL in body.url' });
  }
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  let browser, page;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    page = await browser.newPage();
    await page.setUserAgent(require('./constants').USER_AGENT);
    await page.setCookie(require('./constants').GOOGLE_CONSENT_COOKIE);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 3000));

    const result = await page.evaluate(() => {
      const data = { buttons: [], ariaLabels: [], telLinks: [], dataItemIds: [] };
      document.querySelectorAll('button[data-item-id], a[data-item-id]').forEach(el => {
        const id = el.getAttribute('data-item-id');
        const text = el.innerText.trim().substring(0, 100);
        data.dataItemIds.push({ tag: el.tagName, id, text, href: el.href || '' });
      });
      document.querySelectorAll('button[aria-label]').forEach(btn => {
        data.ariaLabels.push(btn.getAttribute('aria-label'));
      });
      document.querySelectorAll('a[href^="tel:"]').forEach(a => {
        data.telLinks.push(a.href);
      });
      return data;
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (page)    await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

app.get('/api/scrape', (req, res) => {
  res.status(400).json({ error: 'Use POST to submit a scrape request' });
});

// ── POST /api/scrape ── live scrape (also saves to DB) ────────────────────────
app.post('/api/scrape', scrapeLimiter, async (req, res) => {
  const validationErrors = validateInput(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: validationErrors.join(' ') });
  }

  const { countryCode, country, state, city, industry, searchDepth } = req.body;
  const loc = { industry, country: country || '', state: state || '', city: city || '' };

  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // connection likely closed
    }
  };

  let isCancelled = false;
  let keepaliveTimer;
  res.on('close', () => {
    isCancelled = true;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
  });

  keepaliveTimer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(keepaliveTimer);
      return;
    }
    try {
      res.write(':keepalive\n\n');
    } catch (e) {
      clearInterval(keepaliveTimer);
    }
  }, 10000);

  // Mark job as running in DB
  if (isDBConnected() && ScrapeJob) {
    ScrapeJob.findOneAndUpdate(
      { industry: loc.industry, country: loc.country, state: loc.state, city: loc.city },
      { ...loc, status: 'running', errorMsg: '' },
      { upsert: true }
    ).catch(() => {});
  }

  const uniqueLeadsScraped = new Set();

  try {
    sendEvent('status', { message: 'Starting browser...' });

    await scrapeLeads(
      { countryCode, country, state, city, industry, searchDepth: searchDepth || 'medium' },
      async (lead) => {
        sendEvent('lead', lead);
        uniqueLeadsScraped.add(lead.companyName);
        // Save to shared DB asynchronously (don't block the SSE stream)
        saveLeadToDB(lead, loc).catch(() => {});
      },
      (status) => { sendEvent('status', { message: status }); },
      () => isCancelled,
      (browser) => { currentBrowser = browser; }
    );

    if (!isCancelled) {
      // Mark job done in DB
      markJobDone(loc.industry, loc.country, loc.state, loc.city, uniqueLeadsScraped.size).catch(() => {});
      sendEvent('done', { message: 'Scraping completed.', savedToDB: isDBConnected(), leadCount: uniqueLeadsScraped.size });
    }
  } catch (error) {
    console.error('Scraping error:', error);
    sendEvent('error', { message: error.message || 'An error occurred during scraping' });
    if (isDBConnected() && ScrapeJob) {
      ScrapeJob.findOneAndUpdate(
        { industry: loc.industry, country: loc.country, state: loc.state, city: loc.city },
        { status: 'failed', errorMsg: error.message }
      ).catch(() => {});
    }
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
});

// ─── Start server ──────────────────────────────────────────────────────────────
async function startServer() {
  // Connect to DB first (non-blocking — server starts even if DB fails)
  await connectDB();

  // Seed predefined segments into DB
  if (isDBConnected() && Segment) {
    try {
      const ops = PREDEFINED_SEGMENTS.map(name => ({
        updateOne: {
          filter: { name },
          update: { $setOnInsert: { name, isCustom: false } },
          upsert: true,
        },
      }));
      await Segment.bulkWrite(ops, { ordered: false });
      console.log('[DB] Predefined segments seeded.');
    } catch (e) {
      console.warn('[DB] Segment seeding error (non-fatal):', e.message);
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('HTTP server closed.');
      if (currentBrowser) {
        currentBrowser.close().then(() => {
          console.log('Browser closed.');
          process.exit(0);
        }).catch(() => process.exit(1));
      } else {
        process.exit(0);
      }
    });
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 15000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

startServer();
