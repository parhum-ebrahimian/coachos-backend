const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

// GET /api/agent-requests — trainers see own coach's, admins see all
router.get('/', async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      const result = req.query.coach_id
        ? await pool.query(
            'SELECT * FROM agent_requests WHERE coach_id = $1 ORDER BY created_at DESC',
            [req.query.coach_id]
          )
        : await pool.query('SELECT * FROM agent_requests ORDER BY created_at DESC');
      rows = result.rows;
    } else {
      const result = await pool.query(
        'SELECT * FROM agent_requests WHERE coach_id = $1 ORDER BY created_at DESC',
        [req.user.coach_id]
      );
      rows = result.rows;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/agent-requests — trainer submits a request
router.post('/', async (req, res) => {
  const { agent, request_text } = req.body;
  if (!agent || !request_text) {
    return res.status(400).json({ error: 'agent and request_text are required' });
  }
  const targetCoachId = req.user.role === 'admin' && req.body.coach_id
    ? req.body.coach_id
    : req.user.coach_id;

  try {
    const { rows } = await pool.query(
      `INSERT INTO agent_requests (coach_id, agent, request_text)
       VALUES ($1, $2, $3) RETURNING *`,
      [targetCoachId, agent, request_text]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/agent-requests/:id — admin approves or rejects with optional note
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status, admin_note } = req.body;
  const validStatuses = ['pending', 'approved', 'rejected'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE agent_requests
       SET status = $2, admin_note = $3
       WHERE id = $1
       RETURNING *`,
      [req.params.id, status, admin_note || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
