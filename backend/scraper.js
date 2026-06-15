const puppeteer = require('puppeteer');
const { parsePhoneNumber } = require('libphonenumber-js/max');

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

async function scrapeLeads({ countryCode, country, state, city, industry }, onLeadFound, onStatusUpdate, isCancelledFn = () => false) {
  let browser;
  try {
    onStatusUpdate('Launching browser...');
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'CONSENT', value: 'YES+cb.20230101-00-p0.en+FX+410', domain: '.google.com' });
    
    // Construct search query
    const locationParts = [city, state, country].filter(Boolean);
    const locationStr = locationParts.join(', ');
    const query = `${industry} in ${locationStr}`;

    onStatusUpdate(`Searching Google Maps for: ${query}`);
    
    // Go to Google Maps
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for the results to load (checking for the feed or empty state)
    try {
      await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
    } catch (e) {
      onStatusUpdate('No results found or page took too long.');
      return;
    }

    onStatusUpdate('Extracting business listings. Scrolling for more results...');

    // Function to scroll the list to load more results
    let isAborted = false;
    for (let i = 0; i < 15; i++) {
      if (isCancelledFn()) {
        isAborted = true;
        break;
      }
      await page.evaluate(async () => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) {
          feed.scrollBy(0, feed.scrollHeight);
        }
      });
      await new Promise(r => setTimeout(r, 2000));
    }
    
    if (isAborted) {
      onStatusUpdate('Search cancelled by user.');
      return;
    }
    
    // Extract basic details from the list
    const businesses = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('a[href*="/maps/place/"]');
      items.forEach(item => {
        const parent = item.closest('[role="article"]') || item.parentElement.parentElement;
        if (parent) {
          const nameEl = parent.querySelector('.fontHeadlineSmall');
          let name = nameEl ? nameEl.innerText : (item.getAttribute('aria-label') || '');
          
          // Clean up the name: remove descriptions after hyphens, pipes, or slashes
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

    onStatusUpdate(`Found ${businesses.length} potential businesses. Visiting pages...`);

    // We will visit each business's Google Maps detail pane
    for (let i = 0; i < businesses.length; i++) {
      if (isCancelledFn()) {
        onStatusUpdate('Search cancelled by user.');
        break;
      }
      
      const biz = businesses[i];
      onStatusUpdate(`Checking ${biz.name}...`);
      
      try {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await detailPage.setCookie({ name: 'CONSENT', value: 'YES+cb.20230101-00-p0.en+FX+410', domain: '.google.com' });
        await detailPage.goto(biz.url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Extract Phone, Website, Address, Rating
        const details = await detailPage.evaluate(() => {
          let phone = '';
          let website = '';
          let address = '';
          let rating = '';
          
          // Try to find rating
          const ratingEl = document.querySelector('span[role="img"][aria-label*="stars"], div[role="img"][aria-label*="stars"]');
          if (ratingEl) {
            rating = ratingEl.getAttribute('aria-label') || '';
          }

          // Try to find phone button and address
          const buttons = document.querySelectorAll('button[data-item-id]');
          buttons.forEach(btn => {
            const itemId = btn.getAttribute('data-item-id');
            if (itemId && itemId.startsWith('phone:')) {
              const parts = itemId.split(':');
              phone = parts[parts.length - 1];
            }
            if (itemId && itemId.startsWith('authority:')) {
              const el = btn.querySelector('.fontBodyMedium');
              if (el) website = el.innerText;
            }
            if (itemId && itemId.startsWith('address')) {
              const el = btn.querySelector('.fontBodyMedium');
              if (el) address = el.innerText;
            }
          });
          
          // Fallback for website: check a tags
          if (!website) {
            const links = document.querySelectorAll('a[data-item-id^="authority:"]');
            if (links.length > 0) {
              website = links[0].href;
            }
          }
          
          // Fallback for phone: look for anything looking like a phone number in the aria-labels of buttons
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

        let contactPerson = '';
        let email = '';
        let emails = [];
        let socials = [];
        let description = '';
        // If they have a website, try to scrape it for an email, socials, and description
        if (details.website) {
          onStatusUpdate(`Scraping website for ${biz.name}...`);
          try {
            const webPage = await browser.newPage();
            // Prefix http if missing
            let siteUrl = details.website;
            if (!siteUrl.startsWith('http')) siteUrl = 'http://' + siteUrl;
            
            await webPage.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            
            // Extract emails, socials, and description
            const webData = await webPage.evaluate(() => {
              let emails = [];
              let socials = [];
              
              // Check mailto links
              document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                let mail = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
                if (mail) emails.push(mail);
              });

              // Check inner text for raw emails
              const text = document.body.innerText || '';
              const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
              const matches = text.match(emailRegex);
              if (matches) emails.push(...matches);

              // Check social links
              document.querySelectorAll('a').forEach(a => {
                const href = a.href || '';
                if (href.match(/linkedin\.com|facebook\.com|twitter\.com|instagram\.com/i)) {
                  socials.push(href.split('?')[0]);
                }
              });

              // Check Meta Description
              let description = '';
              const metaDesc = document.querySelector('meta[name="description"]');
              if (metaDesc) {
                description = metaDesc.content;
              }
              
              return { 
                emails: [...new Set(emails)],
                socials: [...new Set(socials)],
                description: description.trim()
              };
            });
            
            emails = webData.emails.filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') && !e.endsWith('.gif'));
            socials = webData.socials;
            description = webData.description;
            
            await webPage.close();

            // Extract Domain and Find Decision Makers
            let domain = '';
            try {
               domain = new URL(siteUrl).hostname.replace('www.', '');
            } catch(e) {}
            
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

        // Classify Phone Number
        if (details.phone) {
          try {
            const parsed = parsePhoneNumber(details.phone, countryCode || undefined);
            if (parsed && parsed.isValid()) {
              const type = parsed.getType();
              if (type === 'MOBILE') {
                lead.mobileNumber = parsed.formatInternational();
              } else {
                lead.landlineNumber = parsed.formatInternational();
              }
            } else {
              // Fallback if parsing fails but number exists
              lead.landlineNumber = details.phone;
            }
          } catch (e) {
             // Fallback on library parsing error
             lead.landlineNumber = details.phone;
          }
        }

        // Send all leads found to the frontend
        onLeadFound(lead);

        await detailPage.close();
      } catch (err) {
         console.log(`Error processing business ${biz.name}`, err.message);
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
