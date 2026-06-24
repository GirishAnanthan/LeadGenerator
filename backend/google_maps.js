const { USER_AGENT, GOOGLE_CONSENT_COOKIE, TIMEOUT, WAIT_STRATEGY, PAGINATION, SEARCH_DEPTH } = require('./constants');
const { sleep, createPage, safeEvaluate, safeGoto, closePage } = require('./helpers');

async function scrapeGoogleMapsWithScrolls(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, _countryCode, maxScrolls = PAGINATION.MAX_SCROLLS, _searchDepth = SEARCH_DEPTH.MEDIUM) {
  const mapsPage = await createPage(browser, USER_AGENT);
  await mapsPage.setCookie(GOOGLE_CONSENT_COOKIE);

  onStatusUpdate(`Searching Google Maps for: ${query}`);
  await safeGoto(mapsPage, `https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
    waitUntil: WAIT_STRATEGY.NETWORK_IDLE,
    timeout: TIMEOUT.EXTRA_LONG,
  });

  try {
    await mapsPage.waitForSelector('a[href*="/maps/place/"]', { timeout: TIMEOUT.SHORT });
    onStatusUpdate('Scrolling Maps for more results...');

    for (let i = 0; i < maxScrolls; i++) {
      if (isCancelledFn()) break;
      await mapsPage.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, feed.scrollHeight);
      });
      await sleep(PAGINATION.SLEEP_MS);
    }

    const businesses = await safeEvaluate(mapsPage, () => {
      const results = [];
      document.querySelectorAll('a[href*="/maps/place/"]').forEach(item => {
        const parent = item.closest('[role="article"]') || item.parentElement.parentElement;
        if (parent) {
          const nameEl = parent.querySelector('.fontHeadlineSmall');
          let name = nameEl ? nameEl.innerText : (item.getAttribute('aria-label') || '');
          if (name) {
            name = name.split(' - ')[0].split(' | ')[0].split(' / ')[0].split('/')[0].trim();
            if (!results.some(r => r.name === name)) results.push({ name });
          }
        }
      });
      return results;
    }) || [];

    if (businesses.length === 0) {
      onStatusUpdate('No Maps results found.');
      return;
    }

    onStatusUpdate(`Found ${businesses.length} businesses from Maps.`);
    for (const biz of businesses) {
      if (isCancelledFn()) return;
      existingDomains.add(biz.name.toLowerCase().replace(/\s+/g, ''));
      onLeadFound({
        companyName: biz.name,
        address: '',
        contactPerson: '',
        mobileNumber: '',
        landlineNumber: '',
        emailId: '',
        website: '',
        socials: '',
        description: '',
      });
    }
    onStatusUpdate(`Maps done: ${businesses.length} leads added.`);
  } finally {
    await closePage(mapsPage);
  }
}

module.exports = { scrapeGoogleMapsWithScrolls };
