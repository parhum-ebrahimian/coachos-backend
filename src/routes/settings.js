const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const { updateCoachSchedule } = require('../jobs/scheduler');

const router = express.Router();

router.use(auth);

function resolveCoachId(req) {
  return req.user.role === 'admin' && req.query.coach_id
    ? parseInt(req.query.coach_id, 10)
    : req.user.coach_id;
}

// GET /api/settings/agents
router.get('/agents', async (req, res) => {
  try {
    const id = resolveCoachId(req);
    const { rows } = await pool.query(
      'SELECT * FROM agent_settings WHERE coach_id = $1 ORDER BY agent',
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/settings/agents/:agent — upsert a single agent's settings
router.patch('/agents/:agent', async (req, res) => {
  const { agent } = req.params;
  const id = resolveCoachId(req);
  const allowed = ['autonomous', 'threshold', 'scheduled', 'from_time', 'to_time'];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  const fields = Object.keys(updates);
  const setClauses = fields.map((k, i) => `"${k}" = $${i + 3}`);
  const insertCols = fields.map(k => `"${k}"`).join(', ');
  const insertParams = fields.map((_, i) => `$${i + 3}`).join(', ');
  const values = [id, agent, ...Object.values(updates)];

  try {
    const { rows } = await pool.query(
      `INSERT INTO agent_settings (coach_id, agent, ${insertCols})
       VALUES ($1, $2, ${insertParams})
       ON CONFLICT (coach_id, agent) DO UPDATE
       SET ${setClauses.join(', ')}
       RETURNING *`,
      values
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings/notifications — stored in coaches.branding.notifications
router.get('/notifications', async (req, res) => {
  try {
    const id = resolveCoachId(req);
    const { rows } = await pool.query(
      `SELECT branding->'notifications' AS notifications FROM coaches WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
    res.json(rows[0].notifications || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/settings/notifications — merges into coaches.branding.notifications
router.patch('/notifications', async (req, res) => {
  try {
    const id = resolveCoachId(req);
    const { rows } = await pool.query(
      `UPDATE coaches
       SET branding = jsonb_set(branding, '{notifications}',
         COALESCE(branding->'notifications', '{}') || $2::jsonb, true)
       WHERE id = $1
       RETURNING branding->'notifications' AS notifications`,
      [id, JSON.stringify(req.body)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
    res.json(rows[0].notifications || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings/scan-schedule — stored in coaches.branding.scanSchedule
router.get('/scan-schedule', async (req, res) => {
  try {
    const id = resolveCoachId(req);
    const { rows } = await pool.query(
      `SELECT branding->'scanSchedule' AS scan_schedule FROM coaches WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
    res.json(rows[0].scan_schedule || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/settings/scan-schedule — replaces scanSchedule and hot-reloads the cron job
router.patch('/scan-schedule', async (req, res) => {
  try {
    const id = resolveCoachId(req);
    const { rows } = await pool.query(
      `UPDATE coaches
       SET branding = jsonb_set(branding, '{scanSchedule}', $2::jsonb, true)
       WHERE id = $1
       RETURNING branding->'scanSchedule' AS scan_schedule`,
      [id, JSON.stringify(req.body)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });

    // Hot-reload: cancel old job and create new one without server restart
    await updateCoachSchedule(id);

    res.json(rows[0].scan_schedule);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
