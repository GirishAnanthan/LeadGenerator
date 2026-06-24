const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { SEARCH_DEPTH, CONCURRENCY, PAGINATION } = require('./constants');
const { processConcurrently } = require('./helpers');
const { scrapeGoogleMapsWithScrolls } = require('./google_maps');
const { scrapeGoogleSearchPaginated } = require('./google_search');
const { discoverAndScrapeDirectories } = require('./directories');
const { scrapeUPNEDAVendors, scrapeMPVendors, scrapeMNREVendors } = require('./mnre');

puppeteer.use(StealthPlugin());

function generateQueryVariations(industry, locationStr) {
  const base = `${industry} in ${locationStr}`;
  const ind = industry.toLowerCase();
  const loc = locationStr.toLowerCase();
  const variations = [base];
  variations.push(`${industry} companies ${locationStr}`);
  variations.push(`${industry} manufacturers ${locationStr}`);
  variations.push(`${industry} suppliers ${locationStr}`);
  variations.push(`${industry} dealers ${locationStr}`);
  variations.push(`${industry} factory ${locationStr}`);
  variations.push(`${industry} plant ${locationStr}`);
  variations.push(`${industry} unit ${locationStr}`);
  variations.push(`list of ${industry} ${locationStr}`);
  variations.push(`directory ${industry} ${locationStr}`);
  variations.push(`site:indiamart.com ${ind} ${loc}`);
  variations.push(`site:tradeindia.com ${ind} ${loc}`);
  variations.push(`site:exportersindia.com ${ind} ${loc}`);
  variations.push(`site:justdial.com ${ind} ${loc}`);
  variations.push(`site:zaubacorp.com ${ind} ${loc}`);
  variations.push(`site:corporatedir.com ${ind} ${loc}`);
  if (loc.includes('india')) {
    variations.push(`site:indiamart.com ${ind} in ${loc}`);
    variations.push(`site:tradeindia.com ${ind} in ${loc}`);
  }
  return [...new Set(variations)];
}

async function scrapeLeads(
  { countryCode, country, state, city, industry, searchDepth = 'medium' },
  onLeadFound,
  onStatusUpdate,
  isCancelledFn = () => false,
  onBrowserReady = () => {}
) {
  let browser;
  try {
    onStatusUpdate('Starting lead generation...');
    const locationParts = [city, state, country].filter(Boolean);
    const locationStr = locationParts.join(', ');
    const query = `${industry} in ${locationStr}`;
    const existingDomains = new Set();

    onStatusUpdate('Launching browser...');
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (process.env.PROXY_SERVER) {
      launchArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs,
    });
    onBrowserReady(browser);

    if (industry === 'Solar EPC registered with MNRE') {
      try {
        if (!state || state.toLowerCase().includes('uttar pradesh')) {
          const upLeads = await scrapeUPNEDAVendors(browser, onStatusUpdate, isCancelledFn);
          for (const lead of upLeads) onLeadFound(lead);
        }
        if (!state || state.toLowerCase().includes('madhya pradesh')) {
          const mpLeads = await scrapeMPVendors(browser, onStatusUpdate, isCancelledFn);
          for (const lead of mpLeads) onLeadFound(lead);
        }
        const mnreLeads = await scrapeMNREVendors(browser, state, onStatusUpdate, isCancelledFn);
        for (const lead of mnreLeads) onLeadFound(lead);
        onStatusUpdate('MNRE extraction completed successfully.');
        return;
      } catch (e) {
        console.log('MNRE scraping error:', e);
        return;
      }
    }

    onStatusUpdate(`Search mode: ${searchDepth.toUpperCase()}. ${
      searchDepth === SEARCH_DEPTH.FAST ? 'Only Maps + quick results' :
      searchDepth === SEARCH_DEPTH.MEDIUM ? 'Maps + Google Search' :
      'Full deep search with variations + directories'
    }...`);

    // Phase 1: Google Maps (all depths)
    onStatusUpdate('Scraping Google Maps for quick results...');
    await scrapeGoogleMapsWithScrolls(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, countryCode, PAGINATION.MAX_SCROLLS, searchDepth);

    // Phase 2: Google Search (medium + deep)
    if (searchDepth === SEARCH_DEPTH.MEDIUM || searchDepth === SEARCH_DEPTH.DEEP) {
      if (!isCancelledFn()) {
        onStatusUpdate('Google Search (base query, all pages)...');
        await scrapeGoogleSearchPaginated(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, searchDepth);
      }
    }

    // Deep-only phases
    if (searchDepth === SEARCH_DEPTH.DEEP) {
      if (!isCancelledFn()) {
        onStatusUpdate('Additional Maps queries with alternate search terms...');
        const altMapQueries = generateQueryVariations(industry, locationStr).slice(1, 5);
        await processConcurrently(altMapQueries, CONCURRENCY.LOW, async (mq) => {
          if (isCancelledFn()) return;
          await scrapeGoogleMapsWithScrolls(browser, mq, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, countryCode, PAGINATION.MAX_SCROLLS, searchDepth);
        });
      }

      if (!isCancelledFn()) {
        onStatusUpdate('Searching with query variations and B2B directories...');
        const searchVariations = generateQueryVariations(industry, locationStr).slice(1);
        await processConcurrently(searchVariations, CONCURRENCY.LOW, async (sq, qi) => {
          if (isCancelledFn()) return;
          onStatusUpdate(`Variation ${qi + 2}/${searchVariations.length + 1}: ${sq.substring(0, 80)}...`);
          await scrapeGoogleSearchPaginated(browser, sq, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, searchDepth);
        });
      }

      if (!isCancelledFn()) {
        onStatusUpdate('Discovering industry-specific directories for additional leads...');
        await discoverAndScrapeDirectories(browser, industry, locationStr, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn);
      }
    }
  } catch (error) {
    onStatusUpdate(`Error: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { scrapeLeads };
