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

  // To support server-sent events for real-time updates as we scrape
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendEvent('status', { message: 'Starting browser...' });
    
    let isCancelled = false;
    res.on('close', () => {
      isCancelled = true;
    });

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
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
