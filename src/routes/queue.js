const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const trainerize = require('../services/trainerize');
const { recordEdit } = require('../agents/managingAgent');

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
      ? await pool.query(`SELECT * FROM queue_items WHERE coach_id = $1 AND status = 'pending' ORDER BY created_at DESC`, [id])
      : await pool.query(`SELECT * FROM queue_items WHERE status = 'pending' ORDER BY created_at DESC`);
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
      `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, original_draft, auto_send)
       VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING *`,
      [targetCoachId, agent, client_name, preview || null, draft || null, auto_send]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/queue/stats
router.get('/stats', async (req, res) => {
  try {
    const id = coachId(req);

    const [approvedTodayResult, accuracyResult, activeClientsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count FROM queue_items WHERE coach_id = $1 AND status = 'approved' AND created_at > NOW() - INTERVAL '24 hours'`,
        [id]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'approved') AS total_approved,
           COUNT(*) FILTER (WHERE status = 'approved' AND original_draft = draft) AS approved_without_edit
         FROM queue_items WHERE coach_id = $1`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT client_name) AS count FROM queue_items WHERE coach_id = $1 AND status = 'pending'`,
        [id]
      ),
    ]);

    const totalApproved = parseInt(accuracyResult.rows[0].total_approved, 10);
    const approvedWithoutEdit = parseInt(accuracyResult.rows[0].approved_without_edit, 10);
    const agentAccuracy = totalApproved > 0
      ? Math.round((approvedWithoutEdit / totalApproved) * 100)
      : null;

    res.json({
      approvedToday:  parseInt(approvedTodayResult.rows[0].count, 10),
      agentAccuracy,
      activeClients:  parseInt(activeClientsResult.rows[0].count, 10),
    });
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

    if (
      req.body.draft &&
      existing[0].draft &&
      req.body.draft !== existing[0].draft
    ) {
      recordEdit(existing[0].coach_id, existing[0].agent, existing[0].draft, req.body.draft)
        .catch(err => console.error('[queue] recordEdit failed:', err.message));
    }

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

      await pool.query(`UPDATE queue_items SET status = 'approved' WHERE id = $1`, [item.id]);
      return res.json({ success: true, action: 'meal-plan-sent' });
    }

    if (item.agent === 'messaging' || item.agent === 'progress-monitor') {
      const { rows: coaches } = await pool.query(
        'SELECT trainerize_trainer_id, trainerize_api_key FROM coaches WHERE id = $1',
        [item.coach_id]
      );
      const coach = coaches[0];
      if (!coach?.trainerize_api_key) {
        return res.status(400).json({ error: 'Coach missing Trainerize credentials' });
      }

      const credentials = { groupId: coach.trainerize_trainer_id, apiKey: coach.trainerize_api_key };
      await trainerize.sendMessage(credentials, item.client_id, item.draft);
      await pool.query(`UPDATE queue_items SET status = 'approved' WHERE id = $1`, [item.id]);
      return res.json({ success: true, action: 'message-sent' });
    }

    // workout-monitor and anything else — just mark approved
    await pool.query(`UPDATE queue_items SET status = 'approved' WHERE id = $1`, [item.id]);
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
