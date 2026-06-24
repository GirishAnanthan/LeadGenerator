const { parsePhoneNumber } = require('libphonenumber-js/max');
const { USER_AGENT, GOOGLE_CONSENT_COOKIE, TIMEOUT, WAIT_STRATEGY, PAGINATION, CONCURRENCY, SEARCH_DEPTH, SOCIAL_PATTERNS } = require('./constants');
const { extractDomain, sleep, processConcurrently, createPage, extractEmails, safeEvaluate, safeGoto, closePage } = require('./helpers');
const { findDecisionMakers } = require('./decision_makers');

async function scrapeGoogleMapsWithScrolls(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, countryCode, maxScrolls = PAGINATION.MAX_SCROLLS, searchDepth = SEARCH_DEPTH.MEDIUM) {
  const mapsPage = await createPage(browser, USER_AGENT);
  await mapsPage.setCookie(GOOGLE_CONSENT_COOKIE);

  onStatusUpdate(`Searching Google Maps for: ${query}`);
  await safeGoto(mapsPage, `https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
    waitUntil: WAIT_STRATEGY.NETWORK_IDLE,
    timeout: TIMEOUT.EXTRA_LONG,
  });

  try {
    await mapsPage.waitForSelector('a[href*="/maps/place/"]', { timeout: TIMEOUT.SHORT });
    onStatusUpdate('Extracting business listings. Scrolling for more results...');

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
            if (!results.some(r => r.name === name)) results.push({ name, url: item.href });
          }
        }
      });
      return results;
    }) || [];

    onStatusUpdate(`Found ${businesses.length} potential businesses from Maps. Processing concurrently...`);
    const skipDecisionMakers = searchDepth !== SEARCH_DEPTH.DEEP;

    await processConcurrently(businesses, CONCURRENCY.HIGH, async (biz) => {
      if (isCancelledFn()) return;
      let detailPage, webPage;
      try {
        detailPage = await createPage(browser, USER_AGENT);
        await detailPage.setCookie(GOOGLE_CONSENT_COOKIE);
        await safeGoto(detailPage, biz.url, { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.SHORT });
        if (isCancelledFn()) return;

        const details = await safeEvaluate(detailPage, () => {
          let phone = '', website = '', address = '', rating = '';
          const ratingEl = document.querySelector('span[role="img"][aria-label*="stars"], div[role="img"][aria-label*="stars"]');
          if (ratingEl) rating = ratingEl.getAttribute('aria-label') || '';
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
          return { phone, website, address, rating };
        }) || {};

        let contactPerson = '', emails = [], socials = [], description = '';
        const skipWebsiteVisit = searchDepth === SEARCH_DEPTH.FAST;

        if (details.website && !skipWebsiteVisit) {
          try { existingDomains.add(extractDomain(details.website)); } catch (e) { /* ignore */ }
          webPage = await createPage(browser, USER_AGENT);
          let siteUrl = details.website;
          if (!siteUrl.startsWith('http')) siteUrl = 'http://' + siteUrl;

          try {
            await safeGoto(webPage, siteUrl, { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.SHORT });
            const webData = await safeEvaluate(webPage, () => {
              let emails = [], socials = [];
              document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                const m = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
                if (m) emails.push(m);
              });
              const text = document.body.innerText || '';
              const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
              const matches = text.match(emailRegex);
              if (matches) emails.push(...matches);
              document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                if (/linkedin\.com|facebook\.com|twitter\.com|instagram\.com/i.test(href)) socials.push(href.split('?')[0]);
              });
              const metaDesc = document.querySelector('meta[name="description"]');
              return {
                emails: [...new Set(emails)],
                socials: [...new Set(socials)],
                description: metaDesc ? metaDesc.content.trim() : '',
              };
            }) || {};
            emails = webData.emails || [];
            socials = webData.socials || [];
            description = webData.description || '';

            if (!skipDecisionMakers) {
              const domain = extractDomain(siteUrl);
              if (domain) {
                const dmList = await findDecisionMakers(browser, biz.name, domain);
                if (dmList && dmList.length > 0) {
                  contactPerson = dmList.map(dm => `${dm.name} (${dm.title}):\n${dm.emails.join(', ')}`).join('\n\n');
                }
              }
            }
          } finally {
            await closePage(webPage);
          }
        }

        const lead = {
          companyName: biz.name,
          address: details.address || '',
          contactPerson: contactPerson || '',
          mobileNumber: '',
          landlineNumber: '',
          emailId: emails.length > 0 ? emails.join(', ') : '',
          website: details.website || '',
          socials: socials.length > 0 ? socials.join(', ') : '',
          description: description || '',
        };

        if (details.phone) {
          try {
            const parsed = parsePhoneNumber(details.phone, countryCode || undefined);
            if (parsed && parsed.isValid()) {
              if (parsed.getType() === 'MOBILE') lead.mobileNumber = parsed.formatInternational();
              else lead.landlineNumber = parsed.formatInternational();
            } else lead.landlineNumber = details.phone;
          } catch (e) { lead.landlineNumber = details.phone; }
        }
        onLeadFound(lead);
      } catch (err) {
        console.log(`Error processing Maps business ${biz.name}: ${err.message}`);
      } finally {
        await closePage(detailPage);
      }
    });
  } catch (e) {
    onStatusUpdate('No Maps results found or page took too long.');
  } finally {
    await closePage(mapsPage);
  }
}

module.exports = { scrapeGoogleMapsWithScrolls };
