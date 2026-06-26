const { parsePhoneNumber } = require('libphonenumber-js/max');
const { USER_AGENT, GOOGLE_CONSENT_COOKIE, TIMEOUT, WAIT_STRATEGY, PAGINATION, CONCURRENCY, SEARCH_DEPTH } = require('./constants');
const { sleep, processConcurrently, createPage, safeEvaluate, safeGoto, closePage, extractDomain } = require('./helpers');
const { scrapeContactFromWebsite } = require('./contact_scraper');

// More flexible phone regex that matches Indian and international formats
const PHONE_IN_CARD = /(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3,5}\)?[\s\-.]?\d{3,5}[\s\-.]?\d{3,5}/;

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
            if (!results.some(r => r.name === name)) {
              const cardText = parent.innerText || '';
              const cardLinks = Array.from(parent.querySelectorAll('a')).map(a => a.href).filter(Boolean);
              results.push({
                name,
                url: item.href,
                cardText: cardText.substring(0, 500),
                cardLinks: cardLinks.join(','),
              });
            }
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
  } finally {
    await closePage(mapsPage);
  }

  const skipDetailPages = searchDepth === SEARCH_DEPTH.FAST;

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

    // Extract phone from card text (broad regex)
    const phoneMatch = biz.cardText.match(PHONE_IN_CARD);
    if (phoneMatch) lead.landlineNumber = phoneMatch[0].trim();

    // Extract website from card links
    const websiteLink = biz.cardLinks.split(',').find(l => l.startsWith('http') && !l.includes('google.com/maps'));
    if (websiteLink) lead.website = websiteLink;

    if (!skipDetailPages) {
      let detailPage;
      try {
        detailPage = await createPage(browser, USER_AGENT);
        await detailPage.setCookie(GOOGLE_CONSENT_COOKIE);

        // Give Maps 12 seconds to load JS-rendered content
        try {
          await Promise.race([
            detailPage.goto(biz.url, { waitUntil: 'domcontentloaded' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('nav_timeout')), 12000)),
          ]);
        } catch (navErr) {
          // Navigation timed out or failed — emit what we have
          onLeadFound(lead);
          return;
        }

        // Wait an extra moment for dynamic content to render
        await sleep(2000);

        const details = await safeEvaluate(detailPage, () => {
          let phone = '', website = '', address = '';

          // ── Strategy 1: data-item-id buttons (primary Google Maps method) ──
          document.querySelectorAll('button[data-item-id], a[data-item-id]').forEach(el => {
            const id = el.getAttribute('data-item-id') || '';

            // Phone: data-item-id="phone:tel:+919876543210"
            if (id.startsWith('phone:')) {
              // Remove "phone:tel:" prefix to get raw number
              phone = id.replace(/^phone:(?:tel:)?/, '');
            }

            // Website: data-item-id="authority:example.com"
            if (id.startsWith('authority:')) {
              // For <a> elements, use href directly
              if (el.tagName === 'A' && el.href && !el.href.includes('google.com')) {
                website = el.href;
              } else {
                const textEl = el.querySelector('.fontBodyMedium') ||
                               el.querySelector('[class*="fontBody"]') ||
                               el.querySelector('span');
                if (textEl) website = textEl.innerText.trim();
              }
            }

            // Address: data-item-id="address" or "laddr" or starts with "address"
            if (id === 'address' || id === 'laddr' || id.startsWith('address')) {
              const textEl = el.querySelector('.fontBodyMedium') ||
                             el.querySelector('[class*="fontBody"]') ||
                             el.querySelector('span');
              if (textEl) address = textEl.innerText.trim();
            }
          });

          // ── Strategy 2: aria-label on buttons ──
          if (!phone || !address) {
            document.querySelectorAll('button[aria-label]').forEach(btn => {
              const label = btn.getAttribute('aria-label') || '';
              const lowerLabel = label.toLowerCase();

              // Phone via aria-label: "Phone: +91 98765 43210"
              if (!phone && (lowerLabel.startsWith('phone') || lowerLabel.includes(': +') || lowerLabel.includes(': 0'))) {
                const numMatch = label.match(/[\+\d][\d\s\-\.]{7,}/);
                if (numMatch) phone = numMatch[0].trim();
              }

              // Address via aria-label: "Address: 123 Main St..."
              if (!address && lowerLabel.startsWith('address:')) {
                address = label.replace(/^address:\s*/i, '').trim();
              }
            });
          }

          // ── Strategy 3: look for tel: links on the page ──
          if (!phone) {
            const telLink = document.querySelector('a[href^="tel:"]');
            if (telLink) phone = telLink.getAttribute('href').replace('tel:', '').trim();
          }

          // ── Strategy 4: website fallback from anchor tags ──
          if (!website) {
            const authLink = document.querySelector('a[data-item-id^="authority:"]');
            if (authLink) website = authLink.href;
          }

          // ── Strategy 5: address from structured data / visible content ──
          if (!address) {
            // Try meta itemprop or any element with address content
            const addrEl = document.querySelector('[itemprop="address"], [class*="address"]');
            if (addrEl) address = addrEl.innerText.trim();
          }

          return { phone: phone.trim(), website: website.trim(), address: address.trim() };
        }) || {};

        if (details.address) lead.address = details.address;
        if (details.website) lead.website = details.website;

        if (details.phone) {
          try {
            const parsed = parsePhoneNumber(details.phone, countryCode || undefined);
            if (parsed && parsed.isValid()) {
              if (parsed.getType() === 'MOBILE') {
                lead.mobileNumber = parsed.formatInternational();
                lead.landlineNumber = '';
              } else {
                lead.landlineNumber = parsed.formatInternational();
              }
            } else {
              if (!lead.landlineNumber) lead.landlineNumber = details.phone;
            }
          } catch {
            if (!lead.landlineNumber) lead.landlineNumber = details.phone;
          }
        }

        // ── Visit company website Contact Us page for richer data ──────────────
        if (lead.website && (!lead.mobileNumber || !lead.emailId || !lead.address)) {
          try {
            const contactData = await scrapeContactFromWebsite(browser, lead.website, countryCode);
            if (contactData.mobileNumber && !lead.mobileNumber)   lead.mobileNumber   = contactData.mobileNumber;
            if (contactData.landlineNumber && !lead.landlineNumber) lead.landlineNumber = contactData.landlineNumber;
            if (contactData.emailId && !lead.emailId)             lead.emailId        = contactData.emailId;
            if (contactData.address && !lead.address)             lead.address        = contactData.address;
            if (contactData.contactPerson && !lead.contactPerson) lead.contactPerson  = contactData.contactPerson;
            if (contactData.socials && !lead.socials)             lead.socials        = contactData.socials;
          } catch (e) {
            console.log(`[Maps] Contact scrape failed for ${lead.website}: ${e.message}`);
          }
        }
      } catch (err) {
        console.log(`Maps detail error for ${biz.name}: ${err.message}`);
      } finally {
        await closePage(detailPage);
      }
    }

    onLeadFound(lead);
  });
}

module.exports = { scrapeGoogleMapsWithScrolls };
