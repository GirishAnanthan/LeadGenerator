// puppeteer is now imported dynamically in scrapeLeads to support ESM
const { parsePhoneNumber } = require('libphonenumber-js/max');
const axios = require('axios');
const pdfParse = require('pdf-parse');

function generatePermutations(name, domain) {
  if (!name || !domain) return [];
  const parts = name.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) {
    const first = parts[0];
    return [`${first}@${domain}`];
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const f = first.charAt(0);

  return [
    `${first}@${domain}`,
    `${first}.${last}@${domain}`,
    `${f}${last}@${domain}`,
    `${f}.${last}@${domain}`,
    `${last}@${domain}`,
    `${first}_${last}@${domain}`
  ];
}

async function findDecisionMakers(browser, companyName, domain) {
  let searchPage;
  try {
    searchPage = await browser.newPage();
    const query = `site:linkedin.com/in/ "${companyName}" (CEO OR Founder OR Director OR Owner OR Manager OR President)`;
    await searchPage.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'networkidle2', timeout: 20000 });
    
    // Parse Google Search Results
    const people = await searchPage.evaluate(() => {
      const results = [];
      const blocks = document.querySelectorAll('.g');
      blocks.forEach(block => {
        const titleEl = block.querySelector('h3');
        if (!titleEl) return;
        const titleText = titleEl.innerText || '';
        // Typically: "John Doe - CEO - Company Name | LinkedIn"
        const parts = titleText.split(/ - | \| | – /);
        if (parts.length >= 2) {
          const name = parts[0].trim();
          const title = parts[1].trim();
          // Filter out if the name looks like a company page or job listing
          if (name.length > 2 && name.length < 30 && !name.toLowerCase().includes('jobs') && !name.toLowerCase().includes('linkedin')) {
            results.push({ name, title });
          }
        }
      });
      return results.slice(0, 3); // top 3
    });

    const decisionMakers = [];
    for (const p of people) {
      decisionMakers.push({
        ...p,
        emails: generatePermutations(p.name, domain)
      });
    }
    
    return decisionMakers;
  } catch (err) {
    console.log(`Failed to find decision makers for ${companyName}: ${err.message}`);
    return [];
  } finally {
    if (searchPage) await searchPage.close();
  }
}

const IGNORED_DOMAINS = [
  'yelp.com', 'facebook.com', 'linkedin.com', 'yellowpages.com', 'angi.com', 
  'bbb.org', 'instagram.com', 'twitter.com', 'thumbtack.com', 'tripadvisor.com',
  'glassdoor.com', 'indeed.com', 'zoominfo.com', 'crunchbase.com'
];

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
  // For Indian locations, also search B2B directories
  if (loc.includes('india')) {
    variations.push(`site:indiamart.com ${ind} in ${loc}`);
    variations.push(`site:tradeindia.com ${ind} in ${loc}`);
  }
  return [...new Set(variations)];
}

async function scrapeGoogleSearch(browser, query, existingUrls, onStatusUpdate, isCancelledFn) {
  let searchPage;
  const results = [];
  try {
    searchPage = await browser.newPage();
    await searchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await searchPage.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const links = await searchPage.evaluate(() => {
      const items = [];
      document.querySelectorAll('.g').forEach(block => {
        const a = block.querySelector('a');
        const h3 = block.querySelector('h3');
        if (a && h3 && a.href) {
          items.push({ url: a.href, title: h3.innerText });
        }
      });
      return items;
    });

    for (const link of links) {
      try {
        const urlObj = new URL(link.url);
        const domain = urlObj.hostname.replace('www.', '');
        if (!IGNORED_DOMAINS.includes(domain) && !existingUrls.has(domain)) {
          results.push(link);
          existingUrls.add(domain);
        }
      } catch (e) {}
    }
  } catch (err) {
    console.log(`Google Search failed: ${err.message}`);
  } finally {
    if (searchPage) await searchPage.close();
  }
  return results;
}

async function scrapeGoogleSearchPaginated(browser, query, existingUrls, onStatusUpdate, isCancelledFn) {
  let searchPage;
  const allResults = [];
  const seenUrls = new Set();
  let page = 0;
  let consecutiveEmpty = 0;
  try {
    while (!isCancelledFn()) {
      page++;
      onStatusUpdate(`Google Search page ${page} for: ${query.substring(0, 60)}...`);
      
      searchPage = await browser.newPage();
      await searchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      const url = page === 1 
        ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
        : `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${(page - 1) * 10}`;
      
      await searchPage.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      const links = await searchPage.evaluate(() => {
        const items = [];
        document.querySelectorAll('.g').forEach(block => {
          const a = block.querySelector('a');
          const h3 = block.querySelector('h3');
          if (a && h3 && a.href) {
            items.push({ url: a.href, title: h3.innerText });
          }
        });
        return items;
      });

      if (links.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await searchPage.close();
        searchPage = null;
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      consecutiveEmpty = 0;

      for (const link of links) {
        try {
          const urlObj = new URL(link.url);
          const domain = urlObj.hostname.replace('www.', '');
          if (!IGNORED_DOMAINS.includes(domain) && !existingUrls.has(domain) && !seenUrls.has(link.url)) {
            allResults.push(link);
            existingUrls.add(domain);
            seenUrls.add(link.url);
          }
        } catch (e) {}
      }
      
      await searchPage.close();
      searchPage = null;
      
      if (links.length < 10 && consecutiveEmpty === 0) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.log(`Paginated Google Search failed: ${err.message}`);
  } finally {
    if (searchPage) await searchPage.close().catch(() => {});
  }
  return allResults;
}

async function scrapeGoogleMapsWithScrolls(browser, query, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, countryCode, maxScrolls = 50) {
  let detailPage;
  const mapsPage = await browser.newPage();
  await mapsPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await mapsPage.setCookie({ name: 'CONSENT', value: 'YES+cb.20230101-00-p0.en+FX+410', domain: '.google.com' });
  
  onStatusUpdate(`Searching Google Maps for: ${query}`);
  await mapsPage.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  try {
    await mapsPage.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
    onStatusUpdate('Extracting business listings. Scrolling for more results...');

    for (let i = 0; i < maxScrolls; i++) {
      if (isCancelledFn()) break;
      await mapsPage.evaluate(async () => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, feed.scrollHeight);
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    const businesses = await mapsPage.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('a[href*="/maps/place/"]');
      items.forEach(item => {
        const parent = item.closest('[role="article"]') || item.parentElement.parentElement;
        if (parent) {
          const nameEl = parent.querySelector('.fontHeadlineSmall');
          let name = nameEl ? nameEl.innerText : (item.getAttribute('aria-label') || '');
          if (name) {
             name = name.split(' - ')[0].split(' | ')[0].split(' / ')[0].split('/')[0].trim();
             if (!results.some(r => r.name === name)) {
               results.push({ name, url: item.href });
             }
          }
        }
      });
      return results;
    });

    onStatusUpdate(`Found ${businesses.length} potential businesses from Maps. Visiting pages...`);

    for (let i = 0; i < businesses.length; i++) {
      if (isCancelledFn()) break;
      const biz = businesses[i];
      onStatusUpdate(`Checking ${biz.name}...`);
      
      try {
        detailPage = await browser.newPage();
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await detailPage.setCookie({ name: 'CONSENT', value: 'YES+cb.20230101-00-p0.en+FX+410', domain: '.google.com' });
        await detailPage.goto(biz.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        const details = await detailPage.evaluate(() => {
          let phone = '', website = '', address = '', rating = '';
          const ratingEl = document.querySelector('span[role="img"][aria-label*="stars"], div[role="img"][aria-label*="stars"]');
          if (ratingEl) rating = ratingEl.getAttribute('aria-label') || '';
          const buttons = document.querySelectorAll('button[data-item-id]');
          buttons.forEach(btn => {
            const itemId = btn.getAttribute('data-item-id');
            if (itemId && itemId.startsWith('phone:')) phone = itemId.split(':').pop();
            if (itemId && itemId.startsWith('authority:')) {
              const el = btn.querySelector('.fontBodyMedium');
              if (el) website = el.innerText;
            }
            if (itemId && itemId.startsWith('address')) {
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
        });

        let contactPerson = '', email = '', emails = [], socials = [], description = '';
        
        if (details.website) {
          try { existingDomains.add(new URL(details.website).hostname.replace('www.', '')); } catch(e){}
          onStatusUpdate(`Scraping website for ${biz.name}...`);
          let webPage;
          try {
            webPage = await browser.newPage();
            let siteUrl = details.website;
            if (!siteUrl.startsWith('http')) siteUrl = 'http://' + siteUrl;
            
            await webPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            
            const webData = await webPage.evaluate(() => {
              let emails = [], socials = [];
              document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                let mail = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
                if (mail) emails.push(mail);
              });
              const text = document.body.innerText || '';
              const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
              const matches = text.match(emailRegex);
              if (matches) emails.push(...matches);
              document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                if (href.match(/linkedin\.com|facebook\.com|twitter\.com|instagram\.com/i)) {
                  socials.push(href.split('?')[0]);
                }
              });
              let description = '';
              const metaDesc = document.querySelector('meta[name="description"]');
              if (metaDesc) description = metaDesc.content;
              return { 
                emails: [...new Set(emails)],
                socials: [...new Set(socials)],
                description: description.trim()
              };
            });
            
            emails = webData.emails.filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') && !e.endsWith('.gif'));
            socials = webData.socials;
            description = webData.description;

            let domain = '';
            try { domain = new URL(siteUrl).hostname.replace('www.', ''); } catch(e) {}
            if (domain) {
               onStatusUpdate(`Finding Decision Makers for ${biz.name}...`);
               const dmList = await findDecisionMakers(browser, biz.name, domain);
               if (dmList && dmList.length > 0) {
                  const dmStrings = dmList.map(dm => `${dm.name} (${dm.title}):\n${dm.emails.join(', ')}`);
                  contactPerson = dmStrings.join('\n\n');
               }
            }
          } catch (err) {
            console.log(`Failed to scrape website ${details.website}`, err.message);
          } finally {
            if (webPage) await webPage.close().catch(e => {});
          }
        }

        const lead = {
          companyName: biz.name,
          address: details.address || '',
          rating: details.rating || '',
          contactPerson: contactPerson || '',
          mobileNumber: '',
          landlineNumber: '',
          emailId: emails.length > 0 ? emails.join(', ') : '',
          website: details.website || '',
          socials: socials.length > 0 ? socials.join(', ') : '',
          description: description || ''
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
         console.log(`Error processing Maps business ${biz.name}`, err.message);
      } finally {
         if (detailPage) await detailPage.close().catch(e => {});
      }
    }
  } catch (e) {
    onStatusUpdate('No Maps results found or page took too long.');
  } finally {
    await mapsPage.close().catch(() => {});
  }
}

async function fetchVibeLeads(query, apiKey, onStatusUpdate) {
  if (!apiKey) {
    onStatusUpdate('Skipping Vibe Prospecting API (No VIBE_API_KEY provided)');
    return [];
  }
  onStatusUpdate('Fetching leads from Vibe Prospecting API...');
  // Mock API call to Vibe Prospecting
  // A real implementation would use axios.post('https://api.vibe.us/...', { query })
  await new Promise(r => setTimeout(r, 2000));
  return []; 
}

async function scrapeUPNEDAVendors(browser, onStatusUpdate, isCancelledFn) {
  let page;
  const leads = [];
  try {
    onStatusUpdate(`Searching UPNEDA state portal for vendors with mobile numbers...`);
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://upnedasolarrooftopportal.com/Approved-Firms', { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    // UPNEDA loads all data in a single massive HTML table
    await page.waitForSelector('tbody#all_data tr', { timeout: 15000 });
    
    const rows = await page.evaluate(() => {
        const results = [];
        const trs = document.querySelectorAll('tbody#all_data tr, table tbody tr');
        trs.forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
            if (cells.length >= 6) {
                results.push({
                    companyName: cells[0] || '',
                    mobileNumber: cells[2] || '',
                    emailId: cells[3] || '',
                    district: cells[4] || '',
                    address: cells[5] || ''
                });
            }
        });
        return results;
    });

    for (let i = 0; i < rows.length; i++) {
        if (isCancelledFn()) break;
        const r = rows[i];
        if (!r.companyName || r.companyName.length < 3) continue;
        
        leads.push({
            companyName: r.companyName.substring(0, 100),
            industry: 'Solar EPC registered with MNRE',
            address: `Uttar Pradesh - ${r.district} - ${r.address}`.substring(0, 150),
            contactPerson: '',
            mobileNumber: r.mobileNumber,
            landlineNumber: '',
            emailId: r.emailId,
            website: 'https://upnedasolarrooftopportal.com/Approved-Firms',
            socials: '',
            description: `Extracted from UPNEDA Portal`
        });
    }
    onStatusUpdate(`Found ${leads.length} vendors with mobile numbers from UPNEDA.`);
  } catch(e) {
      console.log(`UPNEDA Scraper Error: ${e.message}`);
  } finally {
      if (page) await page.close().catch(e => {});
  }
  return leads;
}

async function scrapeMPVendors(browser, onStatusUpdate, isCancelledFn) {
  let page;
  const leads = [];
  try {
    onStatusUpdate('Searching Madhya Pradesh (MPMKVVCL) databases...');
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const urls = [
      'https://rooftop.mpcz.in/uwp_rooftop3/vendor_list/1', // Empanelled
      'https://rooftop.mpcz.in/uwp_rooftop3/vendor_list/0'  // Non-Empanelled
    ];

    for (const url of urls) {
        if (isCancelledFn()) break;
        onStatusUpdate(`Scraping MP vendors from ${url.includes('1') ? 'Empanelled' : 'Non-Empanelled'} list...`);
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('MP goto error:', e.message));
        await page.waitForSelector('table', { timeout: 15000 }).catch(e => {});
        
        // Change pagination to all entries (-1) using DataTables API
        const datatableLoaded = await page.evaluate(() => {
            if (window.$ && window.$.fn && window.$.fn.dataTable) {
                const table = window.$('table').DataTable();
                table.page.len(-1).draw();
                return true;
            }
            return false;
        });
        
        if (datatableLoaded) {
            await new Promise(r => setTimeout(r, 3000));
        } else {
            // Fallback if DataTables API fails
            const lengthSelect = await page.$('select[name$="_length"]');
            if (lengthSelect) {
               await page.evaluate(() => {
                   const select = document.querySelector('select[name$="_length"]');
                   if (select) {
                       const opt = document.createElement('option');
                       opt.value = "-1";
                       opt.text = "All";
                       select.appendChild(opt);
                       select.value = "-1";
                       select.dispatchEvent(new Event('change', { bubbles: true }));
                   }
               });
               await new Promise(r => setTimeout(r, 3000));
            }
        }

        const rows = await page.evaluate(() => {
            const results = [];
            const trs = document.querySelectorAll('tbody tr');
            for (let i = 0; i < trs.length; i++) {
                const tds = trs[i].querySelectorAll('td');
                if (tds.length >= 5) {
                    // Filter out the "No data available in table" row
                    const company = tds[1].innerText.trim();
                    if (company && company !== 'No data available in table') {
                        results.push({
                            companyName: company,
                            contactPerson: tds[2].innerText.trim(),
                            mobileNumber: tds[3].innerText.trim(),
                            address: tds[4].innerText.trim()
                        });
                    }
                }
            }
            return results;
        });

        for (let i = 0; i < rows.length; i++) {
            if (isCancelledFn()) break;
            const r = rows[i];
            if (!r.companyName || r.companyName.length < 3) continue;
            
            leads.push({
                companyName: r.companyName.substring(0, 100),
                industry: 'Solar EPC registered with MNRE',
                address: `Madhya Pradesh - ${r.address}`.substring(0, 150),
                contactPerson: r.contactPerson.substring(0, 50),
                mobileNumber: r.mobileNumber,
                landlineNumber: '',
                emailId: '',
                website: 'https://rooftop.mpcz.in/',
                socials: '',
                description: url.includes('1') ? 'Extracted from MP Portal (Empanelled)' : 'Extracted from MP Portal (Non-Empanelled)'
            });
        }
    }
    onStatusUpdate(`Found ${leads.length} vendors with mobile numbers from Madhya Pradesh.`);
  } catch(e) {
      console.log(`MP Scraper Error: ${e.message}`);
  } finally {
      if (page) await page.close().catch(e => {});
  }
  return leads;
}

async function scrapeMNREVendors(browser, state, onStatusUpdate, isCancelledFn) {
  let page;
  const leads = [];
  try {
    const searchMsg = state ? `vendors in ${state}` : `ALL vendors across India`;
    onStatusUpdate(`Searching MNRE database for ${searchMsg}...`);
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://pmsuryagharyojana.in/state-wise-vendor-list/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('MNRE goto error: ' + e.message));
    
    await page.waitForSelector('#stateSelect', { timeout: 10000 });

    const targetStates = await page.evaluate((stateName) => {
      const select = document.querySelector('#stateSelect');
      const results = [];
      for (let i = 0; i < select.options.length; i++) {
        const text = select.options[i].text;
        const val = select.options[i].value;
        if (!val || text.toLowerCase().includes('select')) continue;
        
        if (!stateName || text.toLowerCase().includes(stateName.toLowerCase())) {
          results.push({ text: text, value: val });
        }
      }
      return results;
    }, state || '');

    if (targetStates.length === 0) {
      onStatusUpdate(`Could not find MNRE dropdown options for state.`);
      return leads;
    }

    const pdfLinksToDownload = new Set();

    for (const targetState of targetStates) {
        if (isCancelledFn()) break;
        
        onStatusUpdate(`Selecting state: ${targetState.text}...`);
        await page.bringToFront();
        await page.select('#stateSelect', targetState.value);
        await page.evaluate(() => {
            const select = document.querySelector('#stateSelect');
            if (select) select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        
        // Wait for discoms to load
        await new Promise(r => setTimeout(r, 3000));

        const discoms = await page.evaluate(() => {
          const select = document.querySelector('#discomSelect');
          const options = [];
          if (select) {
            for (let i = 0; i < select.options.length; i++) {
               if (select.options[i].value && !select.options[i].text.toLowerCase().includes('select')) {
                   options.push({ value: select.options[i].value, text: select.options[i].text });
               }
            }
          }
          return options;
        });

        if (discoms.length === 0) {
          onStatusUpdate(`No Discoms found for state ${targetState.text}.`);
          continue;
        }

        for (const discom of discoms) {
           if (isCancelledFn()) break;
           
           let targetPage = page;
           try {
               onStatusUpdate(`Processing State: ${targetState.text} -> Discom: ${discom.text}...`);
               await page.bringToFront();
               await page.select('#stateSelect', targetState.value);
               
               // Dispatch change event to ensure form action updates
               await page.evaluate(() => {
                  const select = document.querySelector('#stateSelect');
                  if (select) select.dispatchEvent(new Event('change', { bubbles: true }));
               });
               await new Promise(r => setTimeout(r, 2000));
               
               await page.select('#discomSelect', discom.value);
               await page.evaluate(() => {
                  const select = document.querySelector('#discomSelect');
                  if (select) select.dispatchEvent(new Event('change', { bubbles: true }));
               });
               await new Promise(r => setTimeout(r, 2000));
               
               // Get direct URL if possible to avoid popup blockers and tab issues
               const directUrl = await page.evaluate((dName) => {
                   if (typeof discomWebsites !== 'undefined' && discomWebsites[dName]) {
                       return discomWebsites[dName];
                   }
                   return null;
               }, discom.text);
               
               if (directUrl) {
                   onStatusUpdate(`Direct URL found for ${discom.text}. Navigating directly...`);
                   targetPage = await browser.newPage();
                   await targetPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                   await targetPage.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto error: ' + e.message));
                   
                   onStatusUpdate(`Waiting for vendor table to load...`);
                   await targetPage.waitForSelector('table.dataTable, table[id^="tablepress"]', { timeout: 15000 }).catch(e => {});
                   await new Promise(r => setTimeout(r, 2000));
               } else {
                   // Fallback to button click if direct URL not found
                   const viewBtn = await page.$('#submitButton');
                   if (viewBtn) {
                       onStatusUpdate(`Clicking View Vendor Details for ${discom.text}...`);
                       
                       const newTargetPromise = new Promise(resolve => {
                           const listener = target => {
                               if (target.type() === 'page') {
                                   browser.off('targetcreated', listener);
                                   resolve(target);
                               }
                           };
                           browser.on('targetcreated', listener);
                       });
                       
                       await page.evaluate(() => document.querySelector('#submitButton').click());
                       
                       const newTarget = await Promise.race([
                          newTargetPromise,
                          new Promise(r => setTimeout(() => r(null), 5000))
                       ]);
                       
                       if (newTarget) {
                           targetPage = await newTarget.page();
                           onStatusUpdate(`New tab opened: ${targetPage.url()}`);
                       }
                       
                       onStatusUpdate(`Waiting for vendor table to load...`);
                       await targetPage.waitForSelector('table.dataTable, table[id^="tablepress"]', { timeout: 15000 }).catch(e => {});
                       await new Promise(r => setTimeout(r, 2000));
                   }
               }

               // Extract table data from the correct page, handling pagination
               onStatusUpdate(`Extracting vendor table data for ${discom.text}...`);
               
               let hasNextPage = true;
               let pageCount = 0;
               // We use a Set to avoid duplicates if pagination redraws overlap
               const uniqueRows = new Set();
               
               while (hasNextPage && pageCount < 100) {
                   pageCount++;
                   onStatusUpdate(`Reading table page ${pageCount} for ${discom.text}...`);
                   
                   const pageRows = await targetPage.evaluate(() => {
                     const results = [];
                     const tables = document.querySelectorAll('table');
                     tables.forEach(t => {
                        if (t.innerText.includes('Important Links') || t.innerText.includes('Solar Rooftop Calculator')) return;
                        t.querySelectorAll('tr').forEach(tr => {
                           const cells = Array.from(tr.querySelectorAll('td, th')).map(td => td.innerText.trim());
                           if (cells.length > 2) results.push(cells.join(' | ')); // must have at least 3 cols to be a valid data row
                        });
                     });
                     if (results.length === 0) {
                         const listItems = document.querySelectorAll('.vendor-list-item, .vendor-row');
                         listItems.forEach(item => results.push(item.innerText.trim().replace(/\n/g, ' | ')));
                     }
                     return results;
                   });
                   
                   pageRows.forEach(r => uniqueRows.add(r));
                   
                   // Try to click "Next"
                   hasNextPage = await targetPage.evaluate(() => {
                       const nextBtn = document.querySelector('.paginate_button.next, .next.page-numbers');
                       if (nextBtn && !nextBtn.classList.contains('disabled') && nextBtn.style.display !== 'none' && !nextBtn.hasAttribute('disabled')) {
                           nextBtn.click();
                           return true;
                       }
                       return false;
                   });
                   
                   if (hasNextPage) {
                       await new Promise(r => setTimeout(r, 1500)); // wait for redraw
                   }
               }
               
               const tableData = Array.from(uniqueRows);
               
               if (tableData.length > 1) {
                  for (let i = 0; i < tableData.length; i++) {
                     const rowText = tableData[i];
                     if (!rowText || rowText.length < 10) continue;
                     // Skip header rows
                     if (rowText.toLowerCase().includes('s.no.') && rowText.toLowerCase().includes('vendor name')) continue;
                     
                     const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/;
                     const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
                     const emMatch = rowText.match(emailRegex);
                     const phMatch = rowText.match(phoneRegex);
                     
                     const columns = rowText.split(' | ');
                     
                     let companyName = `Vendor ${i}`;
                     let contactPerson = '';
                     
                     // If format is: S.No | State | Vendor Name | Email
                     if (columns.length >= 3 && targetState.text.length >= 4 && columns[1].toLowerCase().includes(targetState.text.toLowerCase().substring(0, 4))) {
                         companyName = columns[2];
                     } else if (columns.length >= 3 && columns[0].match(/^\d+$/)) {
                         // Starts with a number, second column is probably company name if it's not state
                         companyName = columns[1];
                         if (companyName.toLowerCase() === targetState.text.toLowerCase()) companyName = columns[2];
                     } else {
                         // Fallback
                         companyName = columns[1] || columns[0] || `Vendor ${i}`;
                         if (companyName.length <= 3 && columns.length > 2) companyName = columns[2];
                         contactPerson = columns.length > 3 ? columns[2] : '';
                     }

                     leads.push({
                        companyName: companyName.substring(0, 100),
                        industry: 'Solar EPC registered with MNRE',
                        address: targetState.text + " - " + discom.text,
                        contactPerson: contactPerson.substring(0, 50),
                        mobileNumber: phMatch ? phMatch[0] : '',
                        landlineNumber: '',
                        emailId: emMatch ? emMatch[0] : '',
                        website: targetPage.url(),
                        socials: '',
                        description: `Extracted from MNRE table. Row: ${rowText.substring(0, 100)}...`
                     });
                  }
               } else {
                   // Also check for PDF links as fallback
                   const links = await targetPage.evaluate(() => {
                     const urls = [];
                     document.querySelectorAll('a').forEach(a => {
                       const text = a.innerText.toLowerCase();
                       const href = a.href.toLowerCase();
                       if (href.endsWith('.pdf') || text.includes('download') || text.includes('view file')) {
                         if (href && href !== window.location.href && !href.includes('javascript:')) urls.push(a.href);
                       }
                     });
                     return urls;
                   });
                   links.forEach(l => pdfLinksToDownload.add(l));
               }
           } catch (err) {
               console.log(`Error processing discom ${discom.text}:`, err);
           } finally {
               if (targetPage !== page) {
                   await targetPage.close().catch(e => {});
               }
           }
        }
    }

    // Process any fallback PDF links found
    if (pdfLinksToDownload.size > 0) {
       let pdfIndex = 1;
       for (const pdfUrl of pdfLinksToDownload) {
          if (isCancelledFn()) break;
          onStatusUpdate(`Found PDF vendor list. Downloading ${pdfUrl}...`);
          try {
             const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
             const data = await pdfParse(response.data);
             const text = data.text;
             
             const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g;
             const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
             
             const emails = [...new Set(text.match(emailRegex) || [])];
             const phones = [...new Set(text.match(phoneRegex) || [])];
             
             if (emails.length > 0 || phones.length > 0) {
                leads.push({
                   companyName: `MNRE Registered Vendors - File ${pdfIndex}`,
                   industry: 'Solar EPC registered with MNRE',
                   address: state,
                   contactPerson: 'Bulk Contacts',
                   mobileNumber: phones[0] || '',
                   landlineNumber: '',
                   emailId: emails.join(', '),
                   website: pdfUrl,
                   socials: '',
                   description: `Extracted ${emails.length} emails and ${phones.length} phones from the state/discom MNRE PDF list.`
                });
                pdfIndex++;
             }
          } catch(err) {
             console.log(`Failed to process PDF ${pdfUrl}: ${err.message}`);
          }
       }
    } else {
      onStatusUpdate(`No download links or PDF files found after selecting Discoms.`);
    }
  } catch(e) {
    console.log(`MNRE Scraper Error: ${e.message}`);
  } finally {
    if (page) await page.close();
  }
  return leads;
}

// === DYNAMIC DIRECTORY DISCOVERY & SCRAPING ===
// For ANY industry + location, dynamically find and scrape industry directories

const B2B_DOMAINS = ['indiamart.com', 'tradeindia.com', 'exportersindia.com', 'justdial.com', 'zaubacorp.com', 'corporatedir.com', 'fastbase.com'];

function generateDirectoryDiscoveryQueries(industry, locationStr) {
  const ind = industry.toLowerCase();
  const loc = locationStr.toLowerCase();
  const queries = [];
  // B2B platform searches
  for (const domain of B2B_DOMAINS) {
    queries.push(`site:${domain} ${ind} ${loc}`);
  }
  // Association / directory searches
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
  const dirIndicators = [
    'directory', 'list of', 'manufacturers', 'suppliers', 'dealers',
    'member', 'association', 'companies', 'vendors', 'factory',
    'indiamart', 'tradeindia', 'exportersindia', 'justdial',
    'catalogue', 'listing', 'catalog', 'find ', 'search ',
    'directory of', 'company list'
  ];
  return dirIndicators.some(ind => text.includes(ind));
}

async function extractDirectoryPage(page, sourceUrl) {
  const data = await page.evaluate(() => {
    const results = [];
    const pageText = document.body.innerText || '';
    
    // Strategy 1: Look for structured listings (tables)
    document.querySelectorAll('table').forEach(table => {
      const rows = table.querySelectorAll('tbody tr, tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const rowText = Array.from(cells).map(c => c.innerText.trim()).filter(t => t.length > 0).join(' | ');
          if (rowText.length > 10 && rowText.length < 500) {
            results.push(rowText);
          }
        }
      });
    });

    // Strategy 2: Look for listing cards / items
    document.querySelectorAll('[class*="listing"], [class*="card"], [class*="item"], [class*="result"], article, li').forEach(el => {
      const text = el.innerText.trim();
      if (text.length > 20 && text.length < 500) {
        const links = el.querySelectorAll('a');
        const hasLinks = links.length > 0;
        const hasContact = text.match(/[\d\s+-]{10,15}/) || text.includes('@');
        if (hasLinks || hasContact) {
          results.push(text);
        }
      }
    });

    // Strategy 3: Extract company-like patterns from text
    const companyPattern = /([A-Z][A-Za-z0-9\s&.,-]+(?:Pvt\.?\s*Ltd|Limited|LLP|Inc|Corp|Industries|Ceramic|Tiles|Granito|Vitrified|Manufacturing|Company|Enterprises|Products))/g;
    const companyMatches = pageText.match(companyPattern);
    if (companyMatches) {
      companyMatches.forEach(name => {
        const trimmed = name.trim();
        if (trimmed.length > 5 && trimmed.length < 100) {
          results.push(`COMPANY: ${trimmed}`);
        }
      });
    }

    return [...new Set(results)].slice(0, 200);
  });
  return data;
}

async function scrapeDirectoryUrl(browser, url, industry, locationStr, onStatusUpdate, isCancelledFn) {
  const leads = [];
  let page;
  try {
    onStatusUpdate(`Scraping directory page: ${url.substring(0, 80)}...`);
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const entries = await extractDirectoryPage(page, url);
    
    for (const entry of entries) {
      if (isCancelledFn()) break;
      const phoneMatch = entry.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      const emailMatch = entry.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
      
      // Extract company name from entry
      let companyName = entry;
      if (entry.startsWith('COMPANY: ')) {
        companyName = entry.replace('COMPANY: ', '');
      } else {
        // Try to get first meaningful line as company name
        const lines = entry.split(' | ').filter(l => l.trim().length > 0);
        if (lines.length > 0) {
          companyName = lines[0];
        }
      }
      
      if (!companyName || companyName.length < 3) continue;
      if (companyName.toLowerCase().includes('no data') || companyName.toLowerCase().includes('s.no.')) continue;

      leads.push({
        companyName: companyName.substring(0, 100),
        industry: industry,
        address: locationStr,
        contactPerson: '',
        mobileNumber: phoneMatch ? phoneMatch[0] : '',
        landlineNumber: '',
        emailId: emailMatch ? emailMatch[0] : '',
        website: url,
        socials: '',
        description: `Discovered from directory: ${url.substring(0, 80)}`
      });
    }
  } catch (e) {
    console.log(`Error scraping directory ${url}: ${e.message}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return leads;
}

// Known optimized scrapers for specific directory sites
// These provide faster, more targeted scraping for well-known directories
const KNOWN_DIRECTORY_SCRAPERS = {
  'ceramicassociation.com': async (browser, onStatusUpdate, isCancelledFn) => {
    // Optimized scraper for Morbi Ceramic Manufacturers Association
    const leads = [];
    let page;
    try {
      onStatusUpdate('Optimized scraper: Morbi Ceramic Association...');
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      const divisions = [
        { id: 6, name: 'Wall Tiles' }, { id: 5, name: 'Vitrified Tiles' },
        { id: 7, name: 'Floor Tiles' }, { id: 8, name: 'GVT Tiles' }, { id: 9, name: 'Sanitaryware' }
      ];

      for (const division of divisions) {
        if (isCancelledFn()) break;
        let pageNum = 1;
        let hasMore = true;
        while (hasMore && pageNum <= 100) {
          if (isCancelledFn()) break;
          await page.goto(`https://ceramicassociation.com/members/${division.id}/${pageNum}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));

          const members = await page.evaluate(() => {
            const r = [];
            document.querySelectorAll('h3').forEach(h3 => {
              const text = h3.innerText.trim();
              if (text && text.length > 3 && !text.toLowerCase().includes('search') && !text.toLowerCase().includes('quick') && !text.toLowerCase().includes('division')) {
                const parent = h3.closest('div');
                const details = parent ? parent.innerText.replace(text, '').trim() : '';
                r.push({ name: text, details });
              }
            });
            return r;
          });

          if (members.length === 0) { hasMore = false; continue; }
          
          for (const m of members) {
            if (!m.name || m.name.length < 3) continue;
            const phoneMatch = m.details.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
            const emailMatch = m.details.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
            leads.push({
              companyName: m.name.substring(0, 100),
              industry: `Ceramic Tiles - ${division.name}`,
              address: 'Morbi, Gujarat, India',
              contactPerson: '', mobileNumber: phoneMatch ? phoneMatch[0] : '', landlineNumber: '',
              emailId: emailMatch ? emailMatch[0] : '',
              website: 'https://ceramicassociation.com', socials: '',
              description: `Source: Morbi Ceramic Association - ${division.name}`
            });
          }
          
          hasMore = await page.evaluate(() => {
            const nl = document.querySelectorAll('a.next, a[rel="next"], .page-numbers a.next');
            return nl.length > 0;
          });
          pageNum++;
        }
      }
      onStatusUpdate(`MCA: Found ${leads.length} companies.`);
    } catch (e) { console.log(`MCA scraper error: ${e.message}`); }
    finally { if (page) await page.close().catch(() => {}); }
    return leads;
  }
};

async function discoverAndScrapeDirectories(browser, industry, locationStr, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn) {
  const totalLeads = [];
  const discoveredUrls = new Set();
  
  // Step 1: Search Google for directory pages
  const discoveryQueries = generateDirectoryDiscoveryQueries(industry, locationStr);
  
  for (const dq of discoveryQueries) {
    if (isCancelledFn()) break;
    onStatusUpdate(`Directory discovery: ${dq.substring(0, 80)}...`);
    
    let searchPage;
    try {
      searchPage = await browser.newPage();
      await searchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await searchPage.goto(`https://www.google.com/search?q=${encodeURIComponent(dq)}`, { waitUntil: 'networkidle2', timeout: 30000 });
      
      const results = await searchPage.evaluate(() => {
        const items = [];
        document.querySelectorAll('.g').forEach(block => {
          const a = block.querySelector('a');
          const h3 = block.querySelector('h3');
          const snippet = block.querySelector('.VwiC3b, .lEBKkf, span.aCOpRe');
          if (a && h3 && a.href) {
            items.push({
              url: a.href,
              title: h3.innerText,
              snippet: snippet ? snippet.innerText : ''
            });
          }
        });
        return items;
      });

      for (const r of results) {
        try {
          const urlObj = new URL(r.url);
          const hostname = urlObj.hostname.replace('www.', '');
          if (!IGNORED_DOMAINS.includes(hostname) && !existingDomains.has(hostname) && !discoveredUrls.has(r.url)) {
            if (looksLikeDirectoryPage(r.url, r.title, r.snippet)) {
              discoveredUrls.add(r.url);
              existingDomains.add(hostname);
            }
          }
        } catch (e) {}
      }
    } catch (err) {
      console.log(`Directory discovery query failed: ${err.message}`);
    } finally {
      if (searchPage) await searchPage.close().catch(() => {});
    }
  }

  // Step 2: Scrape each discovered directory page
  const urls = Array.from(discoveredUrls);
  onStatusUpdate(`Found ${urls.length} potential directory pages. Scraping...`);

  for (const url of urls) {
    if (isCancelledFn()) break;
    try {
      // Check if we have an optimized scraper for this domain
      const urlObj = new URL(url);
      const domain = urlObj.hostname.replace('www.', '');
      let directoryLeads = [];

      if (KNOWN_DIRECTORY_SCRAPERS[domain]) {
        directoryLeads = await KNOWN_DIRECTORY_SCRAPERS[domain](browser, onStatusUpdate, isCancelledFn);
      } else {
        directoryLeads = await scrapeDirectoryUrl(browser, url, industry, locationStr, onStatusUpdate, isCancelledFn);
      }

      for (const lead of directoryLeads) {
        onLeadFound(lead);
        totalLeads.push(lead);
      }
    } catch (e) {
      console.log(`Failed to scrape directory ${url}: ${e.message}`);
    }
  }
  
  return totalLeads;
}

async function scrapeLeads({ countryCode, country, state, city, industry }, onLeadFound, onStatusUpdate, isCancelledFn = () => false) {
  let browser;
  try {
    onStatusUpdate('Starting lead generation...');
    const locationParts = [city, state, country].filter(Boolean);
    const locationStr = locationParts.join(', ');
    const query = `${industry} in ${locationStr}`;

    const existingDomains = new Set();
    const VIBE_API_KEY = process.env.VIBE_API_KEY || '';

    onStatusUpdate('Launching browser...');
    const puppeteerModule = await import('puppeteer');
    const puppeteer = puppeteerModule.default || puppeteerModule;
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // --- MNRE Source ---
    if (industry === 'Solar EPC registered with MNRE') {
       try {
           // Run custom state scrapers first if applicable
           if (!state || state.toLowerCase().includes('uttar pradesh')) {
               const upLeads = await scrapeUPNEDAVendors(browser, onStatusUpdate, isCancelledFn);
               for (const lead of upLeads) {
                  onLeadFound(lead);
                  if (lead.website) {
                     try { existingDomains.add(new URL(lead.website).hostname.replace('www.', '')); } catch(e){}
                  }
               }
           }

           if (!state || state.toLowerCase().includes('madhya pradesh')) {
               const mpLeads = await scrapeMPVendors(browser, onStatusUpdate, isCancelledFn);
               for (const lead of mpLeads) {
                  onLeadFound(lead);
                  if (lead.website) {
                     try { existingDomains.add(new URL(lead.website).hostname.replace('www.', '')); } catch(e){}
                  }
               }
           }
           
           // Then run the National MNRE Scraper (frontend dedupes by company name, keeping the mobile numbers!)
           const mnreLeads = await scrapeMNREVendors(browser, state, onStatusUpdate, isCancelledFn);
           for (const lead of mnreLeads) {
              onLeadFound(lead);
              if (lead.website) {
                 try { existingDomains.add(new URL(lead.website).hostname.replace('www.', '')); } catch(e){}
              }
           }
           onStatusUpdate('MNRE extraction completed successfully.');
           return; // Stop here to prevent polluting results with generic Google Maps vendors
       } catch(e) {
           console.log('MNRE scraping error:', e);
           return;
       }
    }

    // --- 1. Vibe Prospecting API ---
    try {
       const vibeLeads = await fetchVibeLeads(query, VIBE_API_KEY, onStatusUpdate);
       for (const lead of vibeLeads) {
         onLeadFound(lead);
         if (lead.website) {
            try { existingDomains.add(new URL(lead.website).hostname.replace('www.', '')); } catch(e){}
         }
       }
    } catch(err) {
       console.log('Vibe API error:', err.message);
    }

    // --- Dynamic Directory Discovery & Scraping (for ANY industry+location) ---
    await discoverAndScrapeDirectories(browser, industry, locationStr, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn);

    // --- 2. Multi-Query Google Maps Scraping ---
    const mapQueries = generateQueryVariations(industry, locationStr).slice(0, 5); // Use 5 query variations for Maps
    for (const mq of mapQueries) {
      if (isCancelledFn()) break;
      await scrapeGoogleMapsWithScrolls(browser, mq, existingDomains, onLeadFound, onStatusUpdate, isCancelledFn, countryCode, 50);
    }

    // --- 3. Multi-Query Paginated Google Search ---
    if (!isCancelledFn()) {
      onStatusUpdate('Running multi-query Google Search with pagination...');
      const searchQueries = generateQueryVariations(industry, locationStr);
      
      for (let qi = 0; qi < searchQueries.length; qi++) {
        if (isCancelledFn()) break;
        const sq = searchQueries[qi];
        onStatusUpdate(`Search query ${qi + 1}/${searchQueries.length}: ${sq.substring(0, 80)}...`);
        
        const searchResults = await scrapeGoogleSearchPaginated(browser, sq, existingDomains, onStatusUpdate, isCancelledFn);
        
        onStatusUpdate(`Found ${searchResults.length} new websites. Visiting...`);
        
        for (const res of searchResults) {
          if (isCancelledFn()) break;
          onStatusUpdate(`Checking: ${res.title}...`);
          
          try {
              const webPage = await browser.newPage();
              await webPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
              await webPage.goto(res.url, { waitUntil: 'networkidle2', timeout: 20000 });
              
              const webData = await webPage.evaluate(() => {
                let emails = [], socials = [], phone = '';
                document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                  let mail = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
                  if (mail) emails.push(mail);
                });
                document.querySelectorAll('a[href^="tel:"]').forEach(a => {
                  let p = a.getAttribute('href').replace('tel:', '').trim();
                  if (p) phone = p;
                });

                const text = document.body.innerText || '';
                const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
                const matches = text.match(emailRegex);
                if (matches) emails.push(...matches);

                if (!phone) {
                   const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
                   const pMatches = text.match(phoneRegex);
                   if (pMatches) phone = pMatches[0];
                }

                document.querySelectorAll('a').forEach(a => {
                  const href = a.href || '';
                  if (href.match(/linkedin\.com|facebook\.com|twitter\.com|instagram\.com/i)) {
                    socials.push(href.split('?')[0]);
                  }
                });

                let description = '';
                const metaDesc = document.querySelector('meta[name="description"]');
                if (metaDesc) description = metaDesc.content;
                
                return { 
                  emails: [...new Set(emails)],
                  socials: [...new Set(socials)],
                  description: description.trim(),
                  phone: phone
                };
              });
              
              await webPage.close();

              let domain = '';
              try { domain = new URL(res.url).hostname.replace('www.', ''); } catch(e) {}
              
              let contactPerson = '';
              if (domain) {
                 onStatusUpdate(`Finding Decision Makers for ${res.title}...`);
                 const dmList = await findDecisionMakers(browser, res.title, domain);
                 if (dmList && dmList.length > 0) {
                    const dmStrings = dmList.map(dm => `${dm.name} (${dm.title}):\n${dm.emails.join(', ')}`);
                    contactPerson = dmStrings.join('\n\n');
                 }
              }

              const lead = {
                companyName: res.title.split(/ - | \| /)[0].trim(),
                address: '',
                rating: 'N/A (Google Search)',
                contactPerson: contactPerson || '',
                mobileNumber: '',
                landlineNumber: webData.phone || '',
                emailId: webData.emails.length > 0 ? webData.emails.join(', ') : '',
                website: res.url || '',
                socials: webData.socials.length > 0 ? webData.socials.join(', ') : '',
                description: webData.description || ''
              };

              onLeadFound(lead);
          } catch (e) {
              console.log(`Failed to process search result ${res.url}: ${e.message}`);
          }
        }
      }
    }

  } catch (error) {
    onStatusUpdate(`Error: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { scrapeLeads };
