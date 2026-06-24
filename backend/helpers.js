const { PHONE_REGEX, EMAIL_REGEX, RETRY, WAIT_STRATEGY, TIMEOUT } = require('./constants');

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function processConcurrently(items, concurrency, processor) {
  const results = [];
  const queue = [...items];
  let idx = 0;

  async function worker() {
    while (idx < queue.length) {
      const currentIdx = idx++;
      if (currentIdx >= queue.length) break;
      try {
        const result = await processor(queue[currentIdx], currentIdx);
        if (result !== undefined) results.push(result);
      } catch (e) {
        // processor errors handled inside
      }
    }
  }

  const count = Math.min(concurrency, items.length);
  if (count <= 0) return results;
  await Promise.allSettled(Array.from({ length: count }, () => worker()));
  return results;
}

async function retryOperation(fn, maxAttempts = RETRY.MAX_ATTEMPTS, baseDelay = RETRY.BASE_DELAY_MS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(baseDelay * attempt);
    }
  }
}

async function safeGoto(page, url, options = {}) {
  return retryOperation(async () => {
    await page.goto(url, {
      waitUntil: options.waitUntil || WAIT_STRATEGY.NETWORK,
      timeout: options.timeout || TIMEOUT.MEDIUM,
    });
  }, 2, 500);
}

async function safeEvaluate(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch {
    return null;
  }
}

async function createPage(browser, userAgent) {
  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  return page;
}

function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(EMAIL_REGEX) || [];
  return [...new Set(matches.filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') && !e.endsWith('.gif')))];
}

function extractPhones(text) {
  if (!text) return [];
  const matches = text.match(PHONE_REGEX) || [];
  return [...new Set(matches)];
}

function splitCompanyName(title) {
  if (!title) return '';
  return title.split(/ - | \| /)[0].trim();
}

async function closePage(page) {
  if (page) {
    try { await page.close(); } catch (e) { /* ignore */ }
  }
}

module.exports = {
  extractDomain,
  sleep,
  processConcurrently,
  retryOperation,
  safeGoto,
  safeEvaluate,
  createPage,
  extractEmails,
  extractPhones,
  splitCompanyName,
  closePage,
};
