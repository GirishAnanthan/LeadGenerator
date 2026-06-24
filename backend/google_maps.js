const { parsePhoneNumber } = require('libphonenumber-js/max');
const { USER_AGENT, GOOGLE_CONSENT_COOKIE, TIMEOUT, WAIT_STRATEGY, PAGINATION, CONCURRENCY, SEARCH_DEPTH } = require('./constants');
const { sleep, processConcurrently, createPage, safeEvaluate, safeGoto, closePage, extractDomain } = require('./helpers');

async function scrapeGoogleMapsWithScrolls(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, countryCode, maxScrolls = PAGINATION.MAX_SCROLLS, searchDepth = SEARCH_DEPTH.MEDIUM) {
  const mapsPage = await createPage(browser, USER_AGENT);
  await mapsPage.setCookie(GOOGLE_CONSENT_COOKIE);

  onStatusUpdate(`Searching Google Maps for: ${query}`);
  await safeGoto(mapsPage, `https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
    waitUntil: WAIT_STRATEGY.NETWORK_IDLE,
    timeout: TIMEOUT.EXTRA_LONG,
  });

  let businesses = [];
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

    businesses = await safeEvaluate(mapsPage, () => {
      const results = [];
      document.querySelectorAll('a[href*="/maps/place/"]').forEach(item => {
        const parent = item.closest('[role="article"]') || item.parentElement.parentElement;
        if (parent) {
          const nameEl = parent.querySelector('.fontHeadlineSmall');
          let name = nameEl ? nameEl.innerText : (item.getAttribute('aria-label') || '');
          if (name) {
            name = name.split(' - ')[0].split(' | ')[0].split(' / ')[0].split('/')[0].trim();
            if (!results.some(r => r.name === name)) results.push({ name, url: item.href });
          }
        }
      });
      return results;
    }) || [];

    if (businesses.length === 0) return;
    onStatusUpdate(`Found ${businesses.length} business from Maps. Getting details...`);
  } catch (e) {
    onStatusUpdate('Maps search page not available.');
    return;
  } finally {
    await closePage(mapsPage);
  }

  await processConcurrently(businesses, CONCURRENCY.HIGH, async (biz) => {
    if (isCancelledFn()) return;

    const lead = {
      companyName: biz.name,
      address: '',
      contactPerson: '',
      mobileNumber: '',
      landlineNumber: '',
      emailId: '',
      website: '',
      socials: '',
      description: '',
    };

    let detailPage;
    try {
      detailPage = await createPage(browser, USER_AGENT);
      await detailPage.setCookie(GOOGLE_CONSENT_COOKIE);

      try {
        await detailPage.goto(biz.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
      } catch {
        onLeadFound(lead);
        return;
      }

      const details = await safeEvaluate(detailPage, () => {
        let phone = '', website = '', address = '';
        const buttons = document.querySelectorAll('button[data-item-id]');
        buttons.forEach(btn => {
          const id = btn.getAttribute('data-item-id');
          if (id && id.startsWith('phone:')) phone = id.split(':').pop();
          if (id && id.startsWith('authority:')) {
            const el = btn.querySelector('.fontBodyMedium');
            if (el) website = el.innerText;
          }
          if (id && id.startsWith('address')) {
            const el = btn.querySelector('.fontBodyMedium');
            if (el) address = el.innerText;
          }
        });
        if (!website) {
          const links = document.querySelectorAll('a[data-item-id^="authority:"]');
          if (links.length > 0) website = links[0].href;
        }
        if (!phone) {
          document.querySelectorAll('button').forEach(b => {
            const label = b.getAttribute('aria-label') || '';
            if (label.toLowerCase().includes('phone') || label.match(/[\d\s+-]{10,15}/)) {
              const textEl = b.querySelector('.fontBodyMedium');
              if (textEl && textEl.innerText.match(/\d/)) phone = textEl.innerText;
            }
          });
        }
        return { phone, website, address };
      }) || {};

      lead.address = details.address || '';
      lead.website = details.website || '';

      if (details.phone) {
        try {
          const parsed = parsePhoneNumber(details.phone, countryCode || undefined);
          if (parsed && parsed.isValid()) {
            if (parsed.getType() === 'MOBILE') lead.mobileNumber = parsed.formatInternational();
            else lead.landlineNumber = parsed.formatInternational();
          } else lead.landlineNumber = details.phone;
        } catch { lead.landlineNumber = details.phone; }
      }
    } catch (err) {
      console.log(`Maps detail error for ${biz.name}: ${err.message}`);
    } finally {
      await closePage(detailPage);
    }

    onLeadFound(lead);
  });
}

module.exports = { scrapeGoogleMapsWithScrolls };
