// Vercel serverless function — wraps the Stremio addon for serverless deployment
// The addon logic lives in addon.js; this file adapts it for Vercel's (req, res) model.

const addon = require('../addon');

module.exports = async (req, res) => {
  try {
    await addon.handler(req, res);
  } catch (err) {
    console.error('[Vercel] Handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
};
