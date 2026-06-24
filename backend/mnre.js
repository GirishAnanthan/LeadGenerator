const axios = require('axios');
const pdfParse = require('pdf-parse');
const { USER_AGENT, TIMEOUT, WAIT_STRATEGY, EMAIL_REGEX, PHONE_REGEX } = require('./constants');
const { sleep, createPage, safeEvaluate, closePage } = require('./helpers');

async function scrapeUPNEDAVendors(browser, onStatusUpdate, isCancelledFn) {
  let page;
  const leads = [];
  try {
    onStatusUpdate('Searching UPNEDA state portal for vendors with mobile numbers...');
    page = await createPage(browser, USER_AGENT);
    await page.goto('https://upnedasolarrooftopportal.com/Approved-Firms', { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.LONG });
    await page.waitForSelector('tbody#all_data tr', { timeout: TIMEOUT.SHORT });

    const rows = await safeEvaluate(page, () => {
      const results = [];
      document.querySelectorAll('tbody#all_data tr, table tbody tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length >= 6) {
          results.push({ companyName: cells[0] || '', mobileNumber: cells[2] || '', emailId: cells[3] || '', district: cells[4] || '', address: cells[5] || '' });
        }
      });
      return results;
    }) || [];

    for (const r of rows) {
      if (isCancelledFn()) break;
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
        description: 'Extracted from UPNEDA Portal',
      });
    }
    onStatusUpdate(`Found ${leads.length} vendors with mobile numbers from UPNEDA.`);
  } catch (e) {
    console.log(`UPNEDA Scraper Error: ${e.message}`);
  } finally {
    await closePage(page);
  }
  return leads;
}

async function scrapeMPVendors(browser, onStatusUpdate, isCancelledFn) {
  let page;
  const leads = [];
  try {
    onStatusUpdate('Searching Madhya Pradesh (MPMKVVCL) databases...');
    page = await createPage(browser, USER_AGENT);

    const urls = [
      'https://rooftop.mpcz.in/uwp_rooftop3/vendor_list/1',
      'https://rooftop.mpcz.in/uwp_rooftop3/vendor_list/0',
    ];

    for (const url of urls) {
      if (isCancelledFn()) break;
      onStatusUpdate(`Scraping MP vendors from ${url.includes('1') ? 'Empanelled' : 'Non-Empanelled'} list...`);

      await page.goto(url, { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.LONG }).catch(() => {});
      await page.waitForSelector('table', { timeout: TIMEOUT.SHORT }).catch(() => {});

      const datatableLoaded = await safeEvaluate(page, () => {
        if (window.$ && window.$.fn && window.$.fn.dataTable) {
          window.$('table').DataTable().page.len(-1).draw();
          return true;
        }
        return false;
      });

      if (datatableLoaded) {
        await sleep(3000);
      } else {
        await safeEvaluate(page, () => {
          const select = document.querySelector('select[name$="_length"]');
          if (select) {
            const opt = document.createElement('option');
            opt.value = '-1';
            opt.text = 'All';
            select.appendChild(opt);
            select.value = '-1';
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        await sleep(3000);
      }

      const rows = await safeEvaluate(page, () => {
        const results = [];
        document.querySelectorAll('tbody tr').forEach(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 5) {
            const company = tds[1].innerText.trim();
            if (company && company !== 'No data available in table') {
              results.push({ companyName: company, contactPerson: tds[2].innerText.trim(), mobileNumber: tds[3].innerText.trim(), address: tds[4].innerText.trim() });
            }
          }
        });
        return results;
      }) || [];

      for (const r of rows) {
        if (isCancelledFn()) break;
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
          description: url.includes('1') ? 'Extracted from MP Portal (Empanelled)' : 'Extracted from MP Portal (Non-Empanelled)',
        });
      }
    }
    onStatusUpdate(`Found ${leads.length} vendors with mobile numbers from Madhya Pradesh.`);
  } catch (e) {
    console.log(`MP Scraper Error: ${e.message}`);
  } finally {
    await closePage(page);
  }
  return leads;
}

async function scrapeMNREVendors(browser, state, onStatusUpdate, isCancelledFn) {
  let page;
  const leads = [];
  const pdfLinksToDownload = new Set();
  try {
    const searchMsg = state ? `vendors in ${state}` : 'ALL vendors across India';
    onStatusUpdate(`Searching MNRE database for ${searchMsg}...`);
    page = await createPage(browser, USER_AGENT);
    await page.goto('https://pmsuryagharyojana.in/state-wise-vendor-list/', { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.LONG }).catch(() => {});
    await page.waitForSelector('#stateSelect', { timeout: 10000 });

    const targetStates = await safeEvaluate(page, (stateName) => {
      const select = document.querySelector('#stateSelect');
      const results = [];
      for (let i = 0; i < select.options.length; i++) {
        const text = select.options[i].text;
        const val = select.options[i].value;
        if (!val || text.toLowerCase().includes('select')) continue;
        if (!stateName || text.toLowerCase().includes(stateName.toLowerCase())) results.push({ text, value: val });
      }
      return results;
    }, state || '') || [];

    if (targetStates.length === 0) {
      onStatusUpdate('Could not find MNRE dropdown options for state.');
      return leads;
    }

    for (const targetState of targetStates) {
      if (isCancelledFn()) break;
      onStatusUpdate(`Selecting state: ${targetState.text}...`);
      await page.bringToFront();
      await page.select('#stateSelect', targetState.value);
      await page.evaluate(() => { document.querySelector('#stateSelect').dispatchEvent(new Event('change', { bubbles: true })); });
      await sleep(3000);

      const discoms = await safeEvaluate(page, () => {
        const select = document.querySelector('#discomSelect');
        if (!select) return [];
        const options = [];
        for (let i = 0; i < select.options.length; i++) {
          if (select.options[i].value && !select.options[i].text.toLowerCase().includes('select')) {
            options.push({ value: select.options[i].value, text: select.options[i].text });
          }
        }
        return options;
      }) || [];

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
          await page.evaluate(() => { document.querySelector('#stateSelect').dispatchEvent(new Event('change', { bubbles: true })); });
          await sleep(2000);
          await page.select('#discomSelect', discom.value);
          await page.evaluate(() => { document.querySelector('#discomSelect').dispatchEvent(new Event('change', { bubbles: true })); });
          await sleep(2000);

          const directUrl = await safeEvaluate(page, (dName) => {
            if (typeof discomWebsites !== 'undefined' && discomWebsites[dName]) return discomWebsites[dName];
            return null;
          }, discom.text);

          if (directUrl) {
            onStatusUpdate(`Direct URL found for ${discom.text}. Navigating directly...`);
            targetPage = await createPage(browser, USER_AGENT);
            await targetPage.goto(directUrl, { waitUntil: WAIT_STRATEGY.DOM, timeout: TIMEOUT.LONG }).catch(() => {});
            await targetPage.waitForSelector('table.dataTable, table[id^="tablepress"]', { timeout: TIMEOUT.SHORT }).catch(() => {});
            await sleep(2000);
          } else {
            const viewBtn = await page.$('#submitButton');
            if (viewBtn) {
              onStatusUpdate(`Clicking View Vendor Details for ${discom.text}...`);
              const newTargetPromise = new Promise(resolve => {
                const listener = target => { if (target.type() === 'page') { browser.off('targetcreated', listener); resolve(target); } };
                browser.on('targetcreated', listener);
              });
              await page.evaluate(() => document.querySelector('#submitButton').click());
              const newTarget = await Promise.race([newTargetPromise, new Promise(r => setTimeout(() => r(null), 5000))]);
              if (newTarget) {
                targetPage = await newTarget.page();
                onStatusUpdate(`New tab opened: ${targetPage.url()}`);
              }
              await targetPage.waitForSelector('table.dataTable, table[id^="tablepress"]', { timeout: TIMEOUT.SHORT }).catch(() => {});
              await sleep(2000);
            }
          }

          onStatusUpdate(`Extracting vendor table data for ${discom.text}...`);
          const uniqueRows = new Set();
          let hasNextPage = true;
          let pageCount = 0;

          while (hasNextPage && pageCount < 100) {
            pageCount++;
            onStatusUpdate(`Reading table page ${pageCount} for ${discom.text}...`);
            const pageRows = await safeEvaluate(targetPage, () => {
              const results = [];
              document.querySelectorAll('table').forEach(t => {
                if (t.innerText.includes('Important Links') || t.innerText.includes('Solar Rooftop Calculator')) return;
                t.querySelectorAll('tr').forEach(tr => {
                  const cells = Array.from(tr.querySelectorAll('td, th')).map(td => td.innerText.trim());
                  if (cells.length > 2) results.push(cells.join(' | '));
                });
              });
              if (results.length === 0) {
                document.querySelectorAll('.vendor-list-item, .vendor-row').forEach(item => results.push(item.innerText.trim().replace(/\n/g, ' | ')));
              }
              return results;
            }) || [];
            pageRows.forEach(r => uniqueRows.add(r));

            hasNextPage = await safeEvaluate(targetPage, () => {
              const nextBtn = document.querySelector('.paginate_button.next, .next.page-numbers');
              if (nextBtn && !nextBtn.classList.contains('disabled') && nextBtn.style.display !== 'none' && !nextBtn.hasAttribute('disabled')) {
                nextBtn.click();
                return true;
              }
              return false;
            }) || false;

            if (hasNextPage) await sleep(1500);
          }

          const tableData = Array.from(uniqueRows);
          if (tableData.length > 1) {
            for (const rowText of tableData) {
              if (!rowText || rowText.length < 10) continue;
              if (rowText.toLowerCase().includes('s.no.') && rowText.toLowerCase().includes('vendor name')) continue;
              const emMatch = rowText.match(EMAIL_REGEX);
              const phMatch = rowText.match(PHONE_REGEX);
              const columns = rowText.split(' | ');
              let companyName = `Vendor ${leads.length + 1}`;
              let contactPerson = '';
              if (columns.length >= 3 && targetState.text.length >= 4 && columns[1].toLowerCase().includes(targetState.text.toLowerCase().substring(0, 4))) {
                companyName = columns[2];
              } else if (columns.length >= 3 && columns[0].match(/^\d+$/)) {
                companyName = columns[1];
                if (companyName.toLowerCase() === targetState.text.toLowerCase()) companyName = columns[2];
              } else {
                companyName = columns[1] || columns[0] || `Vendor ${leads.length + 1}`;
                if (companyName.length <= 3 && columns.length > 2) companyName = columns[2];
                contactPerson = columns.length > 3 ? columns[2] : '';
              }
              leads.push({
                companyName: companyName.substring(0, 100),
                industry: 'Solar EPC registered with MNRE',
                address: `${targetState.text} - ${discom.text}`,
                contactPerson: contactPerson.substring(0, 50),
                mobileNumber: phMatch ? phMatch[0] : '',
                landlineNumber: '',
                emailId: emMatch ? emMatch[0] : '',
                website: targetPage.url(),
                socials: '',
                description: `Extracted from MNRE table. Row: ${rowText.substring(0, 100)}...`,
              });
            }
          } else {
            const links = await safeEvaluate(targetPage, () => {
              const urls = [];
              document.querySelectorAll('a').forEach(a => {
                const text = a.innerText.toLowerCase();
                const href = a.href.toLowerCase();
                if (href.endsWith('.pdf') || text.includes('download') || text.includes('view file')) {
                  if (href && href !== window.location.href && !href.includes('javascript:')) urls.push(a.href);
                }
              });
              return urls;
            }) || [];
            links.forEach(l => pdfLinksToDownload.add(l));
          }
        } catch (err) {
          console.log(`Error processing discom ${discom.text}:`, err);
        } finally {
          if (targetPage !== page) await closePage(targetPage);
        }
      }
    }

    let pdfIndex = 1;
    for (const pdfUrl of pdfLinksToDownload) {
      if (isCancelledFn()) break;
      onStatusUpdate(`Found PDF vendor list. Downloading ${pdfUrl}...`);
      try {
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer', timeout: TIMEOUT.MEDIUM });
        const data = await pdfParse(response.data);
        const text = data.text;
        const emails = [...new Set((text.match(EMAIL_REGEX) || []))];
        const phones = [...new Set((text.match(PHONE_REGEX) || []))];
        if (emails.length > 0 || phones.length > 0) {
          leads.push({
            companyName: `MNRE Registered Vendors - File ${pdfIndex}`,
            industry: 'Solar EPC registered with MNRE',
            address: state || 'India',
            contactPerson: 'Bulk Contacts',
            mobileNumber: phones[0] || '',
            landlineNumber: '',
            emailId: emails.join(', '),
            website: pdfUrl,
            socials: '',
            description: `Extracted ${emails.length} emails and ${phones.length} phones from the state/discom MNRE PDF list.`,
          });
          pdfIndex++;
        }
      } catch (err) {
        console.log(`Failed to process PDF ${pdfUrl}: ${err.message}`);
      }
    }
  } catch (e) {
    console.log(`MNRE Scraper Error: ${e.message}`);
  } finally {
    await closePage(page);
  }
  return leads;
}

module.exports = { scrapeUPNEDAVendors, scrapeMPVendors, scrapeMNREVendors };
