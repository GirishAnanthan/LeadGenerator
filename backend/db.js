const mongoose = require('mongoose');

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[DB] MONGODB_URI not set — database features disabled.');
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 30000,
    });
    isConnected = true;
    console.log('[DB] Connected to MongoDB Atlas.');
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    // Don't crash — app still works without DB (falls back to live scraping)
  }
}

function isDBConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

module.exports = { connectDB, isDBConnected };
