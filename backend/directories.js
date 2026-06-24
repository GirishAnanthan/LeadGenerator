const { USER_AGENT, TIMEOUT, WAIT_STRATEGY, IGNORED_DOMAINS, B2B_DOMAINS, CONCURRENCY, EMAIL_REGEX, PHONE_REGEX } = require('./constants');
const { extractDomain, sleep, processConcurrently, createPage, safeEvaluate, safeGoto, closePage } = require('./helpers');

function generateDirectoryDiscoveryQueries(industry, locationStr) {
  const ind = industry.toLowerCase();
  const loc = locationStr.toLowerCase();
  const queries = [];
  for (const domain of B2B_DOMAINS) {
    queries.push(`site:${domain} ${ind} ${loc}`);
  }
  queries.push(`"${industry}" association "${locationStr}" members directory`);
  queries.push(`"${industry}" "${locationStr}" list of companies`);
  queries.push(`"${industry}" "${locationStr}" manufacturers list`);
  queries.push(`"${industry}" "${locationStr}" suppliers list`);
  queries.push(`"${industry}" "${locationStr}" directory`);
  queries.push(`list of "${industry}" companies in "${locationStr}"`);
  queries.push(`top "${industry}" companies in "${locationStr}"`);
  queries.push(`"${industry}" companies list "${locationStr}"`);
  queries.push(`"${industry}" manufacturers in "${locationStr}"`);
  return queries;
}

function looksLikeDirectoryPage(url, title, snippet) {
  const text = (url + ' ' + title + ' ' + snippet).toLowerCase();
  const indicators = [
    'directory', 'list of', 'manufacturers', 'suppliers', 'dealers',
    'member', 'association', 'companies', 'vendors', 'factory',
    'indiamart', 'tradeindia', 'exportersindia', 'justdial',
    'catalogue', 'listing', 'catalog', 'find ', 'search ',
    'directory of', 'company list',
  ];
  return indicators.some(ind => text.includes(ind));
}

async function extractDirectoryPage(page) {
  return safeEvaluate(page, () => {
    const results = [];
    const pageText = document.body.innerText || '';

    document.querySelectorAll('table').forEach(table => {
      const rows = table.querySelectorAll('tbody tr, tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const rowText = Array.from(cells).map(c => c.innerText.trim()).filter(t => t.length > 0).join(' | ');
          if (rowText.length > 10 && rowText.length < 500) results.push(rowText);
        }
      });
    });

    document.querySelectorAll('[class*="listing"], [class*="card"], [class*="item"], [class*="result"], article, li').forEach(el => {
      const text = el.innerText.trim();
      if (text.length > 20 && text.length < 500) {
        const links = el.querySelectorAll('a');
        const hasContact = text.match(/[\d\s+-]{10,15}/) || text.includes('@');
        if (links.length > 0 || hasContact) results.push(text);
      }
    });

    const companyPattern = /([A-Z][A-Za-z0-9\s&.,-]+(?:Pvt\.?\s*Ltd|Limited|LLP|Inc|Corp|Industries|Ceramic|Tiles|Granito|Vitrified|Manufacturing|Company|Enterprises|Products))/g;
    const companyMatches = pageText.match(companyPattern);
    if (companyMatches) {
      companyMatches.forEach(name => {
        const trimmed = name.trim();
        if (trimmed.length > 5 && trimmed.length < 100) results.push(`COMPANY: ${trimmed}`);
      });
    }

    return [...new Set(results)].slice(0, 200);
  }) || [];
}

async function scrapeDirectoryUrl(browser, url, industry, locationStr, onStatusUpdate) {
  const leads = [];
  let page;
  try {
    onStatusUpdate(`Scraping directory page: ${url.substring(0, 80)}...`);
    page = await createPage(browser, USER_AGENT);
    await safeGoto(page, url, { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.MEDIUM });
    await sleep(3000);

    const entries = await extractDirectoryPage(page);

    for (const entry of entries) {
      const phoneMatch = entry.match(PHONE_REGEX);
      const emailMatch = entry.match(EMAIL_REGEX);
      let companyName = entry;
      if (entry.startsWith('COMPANY: ')) {
        companyName = entry.replace('COMPANY: ', '');
      } else {
        const lines = entry.split(' | ').filter(l => l.trim().length > 0);
        if (lines.length > 0) companyName = lines[0];
      }
      if (!companyName || companyName.length < 3) continue;
      if (companyName.toLowerCase().includes('no data') || companyName.toLowerCase().includes('s.no.')) continue;

      leads.push({
        companyName: companyName.substring(0, 100),
        industry,
        address: locationStr,
        contactPerson: '',
        mobileNumber: phoneMatch ? phoneMatch[0] : '',
        landlineNumber: '',
        emailId: emailMatch ? emailMatch[0] : '',
        website: url,
        socials: '',
        description: `Discovered from directory: ${url.substring(0, 80)}`,
      });
    }
  } catch (e) {
    console.log(`Error scraping directory ${url}: ${e.message}`);
  } finally {
    await closePage(page);
  }
  return leads;
}

async function discoverAndScrapeDirectories(browser, industry, locationStr, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn) {
  const totalLeads = [];
  const discoveredUrls = new Set();
  const discoveryQueries = generateDirectoryDiscoveryQueries(industry, locationStr);

  for (const dq of discoveryQueries) {
    if (isCancelledFn()) break;
    let searchPage;
    try {
      searchPage = await createPage(browser, USER_AGENT);
      await safeGoto(searchPage, `https://www.google.com/search?q=${encodeURIComponent(dq)}`, {
        waitUntil: WAIT_STRATEGY.NETWORK, timeout: TIMEOUT.MEDIUM,
      });

      const results = await safeEvaluate(searchPage, () => {
        const items = [];
        document.querySelectorAll('.g').forEach(block => {
          const a = block.querySelector('a');
          const h3 = block.querySelector('h3');
          const snippet = block.querySelector('.VwiC3b, .lEBKkf, span.aCOpRe');
          if (a && h3 && a.href) items.push({ url: a.href, title: h3.innerText, snippet: snippet ? snippet.innerText : '' });
        });
        return items;
      }) || [];

      for (const r of results) {
        try {
          const hostname = extractDomain(r.url);
          if (!IGNORED_DOMAINS.includes(hostname) && !existingDomains.has(hostname) && !discoveredUrls.has(r.url)) {
            if (looksLikeDirectoryPage(r.url, r.title, r.snippet)) {
              discoveredUrls.add(r.url);
              existingDomains.add(hostname);
            }
          }
        } catch (e) { /* skip */ }
      }
    } catch (err) {
      console.log(`Directory discovery query failed: ${err.message}`);
    } finally {
      await closePage(searchPage);
    }
  }

  const urls = Array.from(discoveredUrls);
  onStatusUpdate(`Found ${urls.length} potential directory pages. Scraping concurrently...`);

  const allLeads = await processConcurrently(urls, CONCURRENCY.MEDIUM, async (url) => {
    if (isCancelledFn()) return [];
    return scrapeDirectoryUrl(browser, url, industry, locationStr, onStatusUpdate);
  });

  for (const lead of allLeads) {
    if (lead && lead.length > 0) {
      for (const l of lead) {
        onLeadFound(l);
        totalLeads.push(l);
      }
    }
  }

  return totalLeads;
}

module.exports = { discoverAndScrapeDirectories };
