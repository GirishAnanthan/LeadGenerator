const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GOOGLE_CONSENT_COOKIE = { name: 'CONSENT', value: 'YES+cb.20230101-00-p0.en+FX+410', domain: '.google.com' };

const EMAIL_REGEX = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const IMAGE_EXT_REGEX = /\.(png|jpg|jpeg|gif)$/i;

const SOCIAL_PATTERNS = [/linkedin\.com/i, /facebook\.com/i, /twitter\.com/i, /instagram\.com/i];

const TIMEOUT = {
  SHORT: 15000,
  MEDIUM: 30000,
  LONG: 45000,
  EXTRA_LONG: 60000,
};

const WAIT_STRATEGY = {
  DOM: 'domcontentloaded',
  NETWORK: 'networkidle2',
};

const IGNORED_DOMAINS = [
  'yelp.com', 'facebook.com', 'linkedin.com', 'yellowpages.com', 'angi.com',
  'bbb.org', 'instagram.com', 'twitter.com', 'thumbtack.com', 'tripadvisor.com',
  'glassdoor.com', 'indeed.com', 'zoominfo.com', 'crunchbase.com',
];

const B2B_DOMAINS = [
  'indiamart.com', 'tradeindia.com', 'exportersindia.com', 'justdial.com',
  'zaubacorp.com', 'corporatedir.com', 'fastbase.com',
];

const SEARCH_DEPTH = {
  FAST: 'fast',
  MEDIUM: 'medium',
  DEEP: 'deep',
};

const CONCURRENCY = {
  HIGH: 2,
  MEDIUM: 1,
  LOW: 1,
};

const PAGINATION = {
  MAX_SCROLLS: 30,
  MAX_PAGES: 50,
  SLEEP_MS: 2000,
  EMPTY_PAGE_LIMIT: 3,
};

const RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
};

module.exports = {
  USER_AGENT,
  GOOGLE_CONSENT_COOKIE,
  EMAIL_REGEX,
  PHONE_REGEX,
  IMAGE_EXT_REGEX,
  SOCIAL_PATTERNS,
  TIMEOUT,
  WAIT_STRATEGY,
  IGNORED_DOMAINS,
  B2B_DOMAINS,
  SEARCH_DEPTH,
  CONCURRENCY,
  PAGINATION,
  RETRY,
};
