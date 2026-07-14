const express = require('express');

const router = express.Router();

const SECURITY_KEY = '2375b5792c52462f9ede3cddb0c95b18';

// POST /api/webhooks/trainerize
router.post('/trainerize', (req, res) => {
  const provided =
    req.headers['x-trainerize-security'] ||
    req.headers['authorization'] ||
    req.headers['x-security-key'];

  if (provided !== SECURITY_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[Webhook] Headers:', JSON.stringify(req.headers));
  console.log('[Webhook] Body:', JSON.stringify(req.body));

  res.json({ received: true });
});

module.exports = router;
