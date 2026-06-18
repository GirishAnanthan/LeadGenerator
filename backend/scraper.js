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

    // --- 2. Google Maps Scraping ---
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setCookie({ name: 'CONSENT', value: 'YES+cb.20230101-00-p0.en+FX+410', domain: '.google.com' });
    
    onStatusUpdate(`Searching Google Maps for: ${query}`);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    try {
      await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
      onStatusUpdate('Extracting business listings. Scrolling for more results...');

      let isAborted = false;
      for (let i = 0; i < 15; i++) {
        if (isCancelledFn()) {
          isAborted = true;
          break;
        }
        await page.evaluate(async () => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollBy(0, feed.scrollHeight);
        });
        await new Promise(r => setTimeout(r, 2000));
      }
      
      if (isAborted) {
        onStatusUpdate('Search cancelled by user.');
        return;
      }
      
      const businesses = await page.evaluate(() => {
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
        
        let detailPage;
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
           console.log(`Error processing business ${biz.name}`, err.message);
        } finally {
           if (detailPage) await detailPage.close().catch(e => {});
        }
      }
    } catch (e) {
      onStatusUpdate('No Maps results found or page took too long.');
    }

    // --- 3. Google Search Scraping ---
    if (!isCancelledFn()) {
      onStatusUpdate(`Searching general Google Search for more leads...`);
      const searchResults = await scrapeGoogleSearch(browser, query, existingDomains, onStatusUpdate, isCancelledFn);
      onStatusUpdate(`Found ${searchResults.length} new websites from Google Search. Visiting...`);
      
      for (const res of searchResults) {
        if (isCancelledFn()) break;
        onStatusUpdate(`Checking organic result: ${res.title}...`);
        
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
            console.log(`Failed to process Google Search result ${res.url}: ${e.message}`);
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
