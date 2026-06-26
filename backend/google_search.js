const { parsePhoneNumber } = require('libphonenumber-js/max');
const { USER_AGENT, TIMEOUT, WAIT_STRATEGY, IGNORED_DOMAINS, PAGINATION, CONCURRENCY, SEARCH_DEPTH } = require('./constants');
const { extractDomain, sleep, processConcurrently, createPage, safeEvaluate, safeGoto, splitCompanyName, closePage } = require('./helpers');
const { findDecisionMakers } = require('./decision_makers');
const { scrapeContactFromWebsite } = require('./contact_scraper');

async function scrapeGoogleSearchPaginated(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, searchDepth = SEARCH_DEPTH.MEDIUM, countryCode) {
  let searchPage;
  const seenUrls = new Set();
  let page = 0;
  let consecutiveEmpty = 0;
  let totalVisited = 0;
  const skipDecisionMakers = searchDepth !== SEARCH_DEPTH.DEEP;
  const maxSiteVisits = searchDepth === SEARCH_DEPTH.FAST ? 0 : (searchDepth === SEARCH_DEPTH.MEDIUM ? 8 : 20);
  let siteVisits = 0;

  try {
    while (!isCancelledFn()) {
      page++;

      searchPage = await createPage(browser, USER_AGENT);
      const url = page === 1
        ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
        : `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${(page - 1) * 10}`;

      await safeGoto(searchPage, url, { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.MEDIUM });

      const links = await safeEvaluate(searchPage, () => {
        const items = [];
        document.querySelectorAll('.g').forEach(block => {
          const a = block.querySelector('a');
          const h3 = block.querySelector('h3');
          if (a && h3 && a.href) items.push({ url: a.href, title: h3.innerText });
        });
        return items;
      }) || [];

      if (links.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= PAGINATION.EMPTY_PAGE_LIMIT) break;
        await closePage(searchPage);
        searchPage = null;
        await sleep(PAGINATION.SLEEP_MS);
        continue;
      }
      consecutiveEmpty = 0;

      const snippets = await safeEvaluate(searchPage, () => {
        const items = [];
        document.querySelectorAll('.g').forEach(block => {
          const a = block.querySelector('a');
          const h3 = block.querySelector('h3');
          const span = block.querySelector('.VwiC3b, span.aCOpRe, .lEBKkf span');
          if (a && h3 && a.href) {
            items.push({
              url: a.href,
              title: h3.innerText,
              snippet: span ? span.innerText : '',
            });
          }
        });
        return items;
      }) || [];

      await closePage(searchPage);
      searchPage = null;

      const uniqueLinks = [];
      for (const link of links) {
        try {
          const domain = extractDomain(link.url);
          if (IGNORED_DOMAINS.includes(domain) || existingDomains.has(domain) || seenUrls.has(link.url)) continue;
          existingDomains.add(domain);
          seenUrls.add(link.url);
          uniqueLinks.push(link);
        } catch (e) { /* skip */ }
      }

      const snippetMap = {};
      snippets.forEach(s => { snippetMap[s.url] = s.snippet || ''; });

      // Track which links get enriched via site visits
      const enrichedUrls = new Set();

      totalVisited += uniqueLinks.length;

      if (maxSiteVisits > 0 && siteVisits < maxSiteVisits) {
        const visitBatch = uniqueLinks.slice(0, maxSiteVisits - siteVisits);
        siteVisits += visitBatch.length;

        await processConcurrently(visitBatch, CONCURRENCY.HIGH, async (link) => {
          if (isCancelledFn()) return;
          try {
            // Use the dedicated contact scraper — visits homepage + Contact Us page
            const contactData = await scrapeContactFromWebsite(browser, link.url, countryCode);

            let contactPerson = contactData.contactPerson || '';
            if (!skipDecisionMakers && !contactPerson) {
              const domain = extractDomain(link.url);
              if (domain) {
                const dmList = await findDecisionMakers(browser, link.title, domain);
                if (dmList && dmList.length > 0) {
                  contactPerson = dmList.map(d => `${d.name} (${d.title}):\n${d.emails.join(', ')}`).join('\n\n');
                }
              }
            }

            enrichedUrls.add(link.url);
            onLeadFound({
              companyName:    splitCompanyName(link.title),
              address:        contactData.address        || '',
              contactPerson:  contactPerson,
              mobileNumber:   contactData.mobileNumber   || '',
              landlineNumber: contactData.landlineNumber || '',
              emailId:        contactData.emailId        || '',
              website:        link.url                   || '',
              socials:        contactData.socials        || '',
              description:    snippetMap[link.url]       || '',
            });
          } catch (e) {
            console.log(`Failed to process ${link.url}: ${e.message}`);
          }
        });
      }

      // Emit bare leads for links that were NOT enriched (not visited, or visit threw)
      for (const link of uniqueLinks) {
        if (isCancelledFn()) break;
        if (!enrichedUrls.has(link.url)) {
          onLeadFound({
            companyName: splitCompanyName(link.title),
            address: '',
            contactPerson: '',
            mobileNumber: '',
            landlineNumber: '',
            emailId: '',
            website: link.url || '',
            socials: '',
            description: snippetMap[link.url] || '',
          });
        }
      }

      if (links.length < 10) break;
      if (maxSiteVisits > 0 && siteVisits >= maxSiteVisits && page >= 3) break;
      await sleep(PAGINATION.SLEEP_MS);
    }
  } catch (err) {
    console.log(`Paginated Google Search failed: ${err.message}`);
  } finally {
    await closePage(searchPage);
  }
}

module.exports = { scrapeGoogleSearchPaginated };
