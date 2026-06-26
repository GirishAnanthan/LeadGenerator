/**
 * contact_scraper.js
 *
 * Opens a company website, finds the Contact / About page,
 * and extracts phone numbers, emails, address and contact person names.
 */

const { TIMEOUT, WAIT_STRATEGY } = require('./constants');
const { createPage, safeGoto, safeEvaluate, closePage, extractEmails, extractPhones } = require('./helpers');
const { parsePhoneNumber } = require('libphonenumber-js/max');

// Common URL patterns for Contact / About pages
const CONTACT_PAGE_PATTERNS = [
  '/contact', '/contact-us', '/contactus', '/contact_us',
  '/about', '/about-us', '/aboutus',
  '/reach-us', '/reach_us', '/get-in-touch',
  '/connect', '/enquiry', '/enquire',
  '/support', '/help', '/info',
  '/company', '/who-we-are',
];

// Patterns that indicate a contact person name (e.g. "Mr. Rajesh Kumar - MD")
const CONTACT_PERSON_PATTERNS = [
  /(?:mr\.?|mrs\.?|ms\.?|dr\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g,
  /(?:contact|speak\s+to|talk\s+to|reach)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
  /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[-–|]\s*(?:MD|CEO|Director|Manager|Owner|Founder|Partner|Chairman|President|VP|CTO|COO|Proprietor)/gi,
];

// Address-like patterns
const ADDRESS_PATTERNS = [
  /\d+[,\s]+[A-Za-z\s]+(?:Road|Street|Nagar|Colony|Layout|Industrial|Area|Estate|Phase|Sector|Block|Plot|Door|Floor|Building|Tower|Complex|Park|Highway|Marg|Lane|Avenue)[^<\n]{0,200}/gi,
  /(?:P\.?O\.?\s*Box|Plot\s*No|Survey\s*No|Khasra\s*No)[^<\n]{0,150}/gi,
];

/**
 * Extract structured contact data from a single page's text + DOM
 */
function extractContactData(pageText, pageDom) {
  const data = {
    phones: [],
    emails: [],
    address: '',
    contactPersons: [],
  };

  // ── Phones ──────────────────────────────────────────────────────────────────
  const phonePatterns = [
    /\+91[\s\-]?[6-9]\d{9}/g,
    /\b0\d{2,4}[\s\-]?\d{6,8}\b/g,
    /\b[6-9]\d{9}\b/g,
    /\+\d{1,3}[\s\-]?\(?\d{2,4}\)?[\s\-]?\d{3,5}[\s\-]?\d{3,5}/g,
  ];
  for (const pat of phonePatterns) {
    const matches = pageText.match(pat) || [];
    data.phones.push(...matches.map(p => p.trim()));
  }

  // ── Emails ──────────────────────────────────────────────────────────────────
  const emailMatches = pageText.match(/([a-zA-Z0-9._+-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/gi) || [];
  data.emails = [...new Set(emailMatches.filter(e =>
    !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') &&
    !e.includes('example.com') && !e.includes('yourdomain') && !e.includes('domain.com')
  ))];

  // ── Address ─────────────────────────────────────────────────────────────────
  for (const pat of ADDRESS_PATTERNS) {
    const match = pageText.match(pat);
    if (match && match[0] && match[0].trim().length > 15) {
      data.address = match[0].trim().replace(/\s+/g, ' ').substring(0, 300);
      break;
    }
  }

  // ── Contact Persons ─────────────────────────────────────────────────────────
  for (const pat of CONTACT_PERSON_PATTERNS) {
    let m;
    const textToSearch = pageText;
    const regex = new RegExp(pat.source, pat.flags);
    while ((m = regex.exec(textToSearch)) !== null) {
      const name = (m[1] || m[0]).trim();
      if (name.length > 3 && name.length < 60) {
        data.contactPersons.push(name);
      }
    }
  }
  data.contactPersons = [...new Set(data.contactPersons)].slice(0, 3);

  return data;
}

/**
 * Scrape the homepage + best contact page of a website.
 * Returns { phones, emails, address, contactPersons, socials }
 */
async function scrapeContactFromWebsite(browser, websiteUrl, countryCode) {
  const result = {
    mobileNumber: '',
    landlineNumber: '',
    emailId: '',
    address: '',
    contactPerson: '',
    socials: '',
    contactPageUrl: '',
  };

  if (!websiteUrl) return result;

  let homePage;
  const baseUrl = websiteUrl.replace(/\/$/, '').split('/').slice(0, 3).join('/'); // e.g. https://example.com

  try {
    // ── Step 1: Load homepage ──────────────────────────────────────────────────
    homePage = await createPage(browser, require('./constants').USER_AGENT);
    await safeGoto(homePage, websiteUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT.SHORT });

    const homeData = await safeEvaluate(homePage, () => {
      // tel: links are most reliable
      const telPhones = [];
      document.querySelectorAll('a[href^="tel:"]').forEach(a => {
        const p = a.getAttribute('href').replace('tel:', '').trim();
        if (p) telPhones.push(p);
      });

      // mailto: links
      const mailtos = [];
      document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        const m = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
        if (m && m.includes('@')) mailtos.push(m);
      });

      // Social links
      const socialLinks = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href || '';
        if (/linkedin\.com|facebook\.com|twitter\.com|instagram\.com/i.test(h)) {
          socialLinks.push(h.split('?')[0]);
        }
      });

      // Find contact page links on the homepage
      const contactLinks = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        const text = (a.innerText || '').toLowerCase();
        if (
          href.includes('contact') || href.includes('about') ||
          href.includes('enquir') || href.includes('reach') ||
          text === 'contact' || text === 'contact us' || text === 'about us' ||
          text === 'about' || text === 'enquiry' || text.includes('reach us')
        ) {
          const full = a.href;
          if (full && full.startsWith('http') && !full.includes('#')) {
            contactLinks.push(full);
          }
        }
      });

      const text = document.body ? document.body.innerText : '';
      return { telPhones, mailtos, socialLinks: [...new Set(socialLinks)], contactLinks: [...new Set(contactLinks)].slice(0, 5), text: text.substring(0, 5000) };
    }) || {};

    // Extract from homepage text
    const homeExtracted = extractContactData(homeData.text || '', null);

    // Prefer tel: links over text extraction
    const allPhones = [...(homeData.telPhones || []), ...homeExtracted.phones];
    const allEmails = [...(homeData.mailtos || []), ...homeExtracted.emails];
    let address = homeExtracted.address;
    let contactPersons = homeExtracted.contactPersons;
    const socials = homeData.socialLinks || [];

    await closePage(homePage);
    homePage = null;

    // ── Step 2: Find and visit Contact page ────────────────────────────────────
    // Build candidate URLs: links found on homepage + common patterns
    const contactCandidates = [
      ...(homeData.contactLinks || []),
      ...CONTACT_PAGE_PATTERNS.map(p => `${baseUrl}${p}`),
      ...CONTACT_PAGE_PATTERNS.map(p => `${baseUrl}${p}.html`),
      ...CONTACT_PAGE_PATTERNS.map(p => `${baseUrl}${p}.php`),
    ];

    // Try the first 3 unique candidates
    const tried = new Set();
    for (const contactUrl of contactCandidates) {
      if (tried.size >= 3) break;
      if (tried.has(contactUrl)) continue;
      tried.add(contactUrl);

      let contactPage;
      try {
        contactPage = await createPage(browser, require('./constants').USER_AGENT);

        const navResult = await Promise.race([
          contactPage.goto(contactUrl, { waitUntil: 'domcontentloaded' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]).catch(() => null);

        if (!navResult) { await closePage(contactPage); contactPage = null; continue; }

        // Check if page actually exists (not 404)
        const statusOk = await safeEvaluate(contactPage, () => {
          const title = (document.title || '').toLowerCase();
          const body = (document.body ? document.body.innerText : '').substring(0, 200).toLowerCase();
          return !title.includes('404') && !title.includes('not found') && !body.includes('page not found');
        });

        if (!statusOk) { await closePage(contactPage); contactPage = null; continue; }
        
        result.contactPageUrl = contactUrl; // Store the valid contact page URL

        const contactData = await safeEvaluate(contactPage, () => {
          const telPhones = [];
          document.querySelectorAll('a[href^="tel:"]').forEach(a => {
            const p = a.getAttribute('href').replace('tel:', '').trim();
            if (p) telPhones.push(p);
          });

          const mailtos = [];
          document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
            const m = a.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
            if (m && m.includes('@')) mailtos.push(m);
          });

          // Address from structured data or address tags
          let structuredAddress = '';
          const addrEl = document.querySelector('[itemprop="address"], address, .address, #address, [class*="addr"], [id*="addr"]');
          if (addrEl) structuredAddress = addrEl.innerText.trim().replace(/\s+/g, ' ').substring(0, 300);

          const text = document.body ? document.body.innerText : '';
          return { telPhones, mailtos, structuredAddress, text: text.substring(0, 8000) };
        }) || {};

        const contactExtracted = extractContactData(contactData.text || '', null);

        // Merge — contact page data takes priority
        allPhones.push(...(contactData.telPhones || []), ...contactExtracted.phones);
        allEmails.push(...(contactData.mailtos || []), ...contactExtracted.emails);

        if (!address && contactData.structuredAddress) address = contactData.structuredAddress;
        if (!address && contactExtracted.address) address = contactExtracted.address;
        if (contactExtracted.contactPersons.length > 0) {
          contactPersons = [...new Set([...contactPersons, ...contactExtracted.contactPersons])].slice(0, 3);
        }

        // If we got useful data, stop trying more contact pages
        if (allPhones.length > 0 || allEmails.length > 0) break;

      } catch (e) {
        // Skip — try next candidate
      } finally {
        await closePage(contactPage);
      }
    }

    // ── Step 3: Parse and classify phones ─────────────────────────────────────
    const uniquePhones = [...new Set(allPhones.map(p => p.replace(/\s+/g, '')).filter(Boolean))];
    for (const rawPhone of uniquePhones) {
      if (result.mobileNumber && result.landlineNumber) break;
      try {
        const parsed = parsePhoneNumber(rawPhone, countryCode || 'IN');
        if (parsed && parsed.isValid()) {
          const formatted = parsed.formatInternational();
          if (parsed.getType() === 'MOBILE' && !result.mobileNumber) {
            result.mobileNumber = formatted;
          } else if (!result.landlineNumber) {
            result.landlineNumber = formatted;
          }
        } else if (!result.landlineNumber) {
          result.landlineNumber = rawPhone;
        }
      } catch {
        if (!result.landlineNumber) result.landlineNumber = rawPhone;
      }
    }

    // ── Step 4: Set results ────────────────────────────────────────────────────
    const uniqueEmails = [...new Set(allEmails)];
    result.emailId = uniqueEmails.slice(0, 2).join(', ');
    result.address = address;
    result.contactPerson = contactPersons.slice(0, 2).join(', ');
    result.socials = [...new Set(socials)].slice(0, 4).join(', ');

  } catch (err) {
    console.log(`[ContactScraper] Error for ${websiteUrl}: ${err.message}`);
  } finally {
    await closePage(homePage);
  }

  return result;
}

module.exports = { scrapeContactFromWebsite };
