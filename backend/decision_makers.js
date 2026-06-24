const { USER_AGENT, TIMEOUT, WAIT_STRATEGY } = require('./constants');
const { createPage, closePage } = require('./helpers');

function generatePermutations(name, domain) {
  if (!name || !domain) return [];
  const parts = name.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) {
    return [`${parts[0]}@${domain}`];
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
    `${first}_${last}@${domain}`,
  ];
}

async function findDecisionMakers(browser, companyName, domain) {
  let searchPage;
  try {
    searchPage = await createPage(browser, USER_AGENT);
    const query = `site:linkedin.com/in/ "${companyName}" (CEO OR Founder OR Director OR Owner OR Manager OR President)`;
    await searchPage.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: WAIT_STRATEGY.NETWORK,
      timeout: TIMEOUT.MEDIUM,
    });

    const people = await searchPage.evaluate(() => {
      const results = [];
      document.querySelectorAll('.g').forEach(block => {
        const titleEl = block.querySelector('h3');
        if (!titleEl) return;
        const titleText = titleEl.innerText || '';
        const parts = titleText.split(/ - | \| | – /);
        if (parts.length >= 2) {
          const name = parts[0].trim();
          const title = parts[1].trim();
          if (name.length > 2 && name.length < 30 && !name.toLowerCase().includes('jobs') && !name.toLowerCase().includes('linkedin')) {
            results.push({ name, title });
          }
        }
      });
      return results.slice(0, 3);
    });

    return people.map(p => ({
      ...p,
      emails: generatePermutations(p.name, domain),
    }));
  } catch (err) {
    console.log(`Failed to find decision makers for ${companyName}: ${err.message}`);
    return [];
  } finally {
    await closePage(searchPage);
  }
}

module.exports = { findDecisionMakers, generatePermutations };
