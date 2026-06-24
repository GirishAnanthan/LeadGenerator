const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { scrapeLeads } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;

let currentBrowser = null;

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/scrape', (req, res) => {
  res.status(400).json({ error: 'Use POST to submit a scrape request' });
});

app.post('/api/scrape', scrapeLimiter, async (req, res) => {
  const validationErrors = validateInput(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: validationErrors.join(' ') });
  }

  const { countryCode, country, state, city, industry, searchDepth } = req.body;

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

  try {
    sendEvent('status', { message: 'Starting browser...' });

    await scrapeLeads(
      { countryCode, country, state, city, industry, searchDepth: searchDepth || 'medium' },
      (lead) => { sendEvent('lead', lead); },
      (status) => { sendEvent('status', { message: status }); },
      () => isCancelled,
      (browser) => { currentBrowser = browser; }
    );

    if (!isCancelled) {
      sendEvent('done', { message: 'Scraping completed.' });
    }
  } catch (error) {
    console.error('Scraping error:', error);
    sendEvent('error', { message: error.message || 'An error occurred during scraping' });
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
});

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
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
