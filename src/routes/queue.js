const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const trainerize = require('../services/trainerize');

const router = express.Router();

router.use(auth);

function coachId(req) {
  return req.user.role === 'admin' && req.query.coach_id
    ? parseInt(req.query.coach_id, 10)
    : req.user.coach_id;
}

// GET /api/queue
router.get('/', async (req, res) => {
  try {
    const id = coachId(req);
    const { rows } = id
      ? await pool.query('SELECT * FROM queue_items WHERE coach_id = $1 ORDER BY created_at DESC', [id])
      : await pool.query('SELECT * FROM queue_items ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/queue
router.post('/', async (req, res) => {
  const { agent, client_name, preview, draft, auto_send = false } = req.body;
  if (!agent || !client_name) {
    return res.status(400).json({ error: 'agent and client_name are required' });
  }
  const targetCoachId = req.user.role === 'admin' && req.body.coach_id
    ? req.body.coach_id
    : req.user.coach_id;

  try {
    const { rows } = await pool.query(
      `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [targetCoachId, agent, client_name, preview || null, draft || null, auto_send]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/queue/:id — update draft, preview, or auto_send (approve = true, reject = false)
router.patch('/:id', async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM queue_items WHERE id = $1', [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Queue item not found' });
    if (req.user.role !== 'admin' && existing[0].coach_id !== req.user.coach_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const allowed = ['agent', 'client_name', 'preview', 'draft', 'auto_send'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const setClauses = Object.keys(updates).map((k, i) => `"${k}" = $${i + 2}`);
    const values = [req.params.id, ...Object.values(updates)];

    const { rows } = await pool.query(
      `UPDATE queue_items SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/queue/:id/approve
router.post('/:id/approve', async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM queue_items WHERE id = $1', [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Queue item not found' });
    const item = existing[0];
    if (req.user.role !== 'admin' && item.coach_id !== req.user.coach_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (item.agent === 'meal-plan') {
      const { rows: coaches } = await pool.query(
        'SELECT trainerize_trainer_id, trainerize_api_key FROM coaches WHERE id = $1',
        [item.coach_id]
      );
      const coach = coaches[0];
      if (!coach?.trainerize_api_key) {
        return res.status(400).json({ error: 'Coach missing Trainerize credentials' });
      }

      const credentials = { groupId: coach.trainerize_trainer_id, apiKey: coach.trainerize_api_key };
      await trainerize.sendMessage(credentials, parseInt(item.client_id, 10), item.draft);

      await pool.query('DELETE FROM queue_items WHERE id = $1', [item.id]);
      return res.json({ success: true, action: 'meal-plan-sent' });
    }

    // progress-monitor, messaging, workout-monitor — approve and clear
    await pool.query('DELETE FROM queue_items WHERE id = $1', [item.id]);
    return res.json({ success: true, action: 'approved' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/queue/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT coach_id FROM queue_items WHERE id = $1', [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Queue item not found' });
    if (req.user.role !== 'admin' && existing[0].coach_id !== req.user.coach_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query('DELETE FROM queue_items WHERE id = $1', [req.params.id]);
    res.json({ deleted: parseInt(req.params.id, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
