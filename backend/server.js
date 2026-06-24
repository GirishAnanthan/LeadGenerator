const express = require('express');
const cors = require('cors');
const { scrapeLeads } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.post('/api/scrape', async (req, res) => {
  const { countryCode, country, state, city, industry, searchDepth } = req.body;
  
  if (!industry) {
    return res.status(400).json({ error: 'Industry is required' });
  }

  // Disable idle timeout so background tabs don't kill the connection
  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch(e) {}
  };

  let isCancelled = false;
  let keepaliveTimer;
  res.on('close', () => {
    isCancelled = true;
    if (keepaliveTimer) clearInterval(keepaliveTimer);
  });

  // Keepalive ping every 10s to prevent connection drop when tab is backgrounded
  keepaliveTimer = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch(e) { clearInterval(keepaliveTimer); }
  }, 10000);

  try {
    sendEvent('status', { message: 'Starting browser...' });
    
    await scrapeLeads({ countryCode, country, state, city, industry, searchDepth }, (lead) => {
      sendEvent('lead', lead);
    }, (status) => {
      sendEvent('status', { message: status });
    }, () => isCancelled);

    if (!isCancelled) {
      sendEvent('done', { message: 'Scraping completed.' });
    }
  } catch (error) {
    console.error('Scraping error:', error);
    sendEvent('error', { message: error.message || 'An error occurred during scraping' });
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
