const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(auth);

// GET /api/coaches — admin only
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coaches ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/coaches/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coaches WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
    // trainers can only see their own coach
    if (req.user.role !== 'admin' && rows[0].id !== req.user.coach_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/coaches — admin only
router.post('/', requireAdmin, async (req, res) => {
  const { name, email, username, password, plan = 'free', subdomain, branding = {} } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (!password) return res.status(400).json({ error: 'password is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO coaches (name, email, plan, subdomain, branding)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, email, plan, subdomain || null, JSON.stringify(branding)]
    );
    const coach = rows[0];

    const password_hash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (username, password_hash, name, role, coach_id, deletable)
       VALUES ($1, $2, $3, 'trainer', $4, true)`,
      [username, password_hash, name, coach.id]
    );

    await client.query('COMMIT');
    res.status(201).json(coach);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email, subdomain, or username already in use' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PATCH /api/coaches/:id
router.patch('/:id', async (req, res) => {
  const isAdmin = req.user.role === 'admin';

  if (!isAdmin) {
    if (String(req.user.coach_id) !== String(req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const adminFields   = ['name', 'email', 'plan', 'subdomain', 'branding', 'trainerize_api_key', 'trainerize_trainer_id', 'voice_guide', 'meal_plan_instructions'];
  const trainerFields = ['trainerize_api_key', 'trainerize_trainer_id', 'voice_guide', 'meal_plan_instructions'];
  const allowed = isAdmin ? adminFields : trainerFields;

  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  const status = isAdmin ? req.body.status : undefined;

  if (Object.keys(updates).length === 0 && status === undefined) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  try {
    let row;

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map((k, i) => `"${k}" = $${i + 2}`);
      const values = [req.params.id, ...Object.values(updates)];
      const { rows } = await pool.query(
        `UPDATE coaches SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
        values
      );
      if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
      row = rows[0];
    }

    if (status !== undefined) {
      const { rows } = await pool.query(
        `UPDATE coaches SET branding = jsonb_set(branding::jsonb, '{status}', $2::jsonb, true) WHERE id = $1 RETURNING *`,
        [req.params.id, JSON.stringify(status)]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
      row = rows[0];
    }

    res.json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email or subdomain already in use' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/coaches/:id/username — admin only
router.patch('/:id/username', requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  try {
    const { rows: taken } = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND coach_id != $2 LIMIT 1',
      [username, req.params.id]
    );
    if (taken.length > 0) {
      return res.status(409).json({ error: 'Username is already taken' });
    }
    await pool.query(
      'UPDATE users SET username = $1 WHERE coach_id = $2',
      [username, req.params.id]
    );
    res.json({ success: true, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/coaches/:id/reset-password — admin only
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE coach_id = $2',
      [password_hash, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/coaches/:id — admin only; blocked if coach has non-deletable users
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { rows: blocked } = await pool.query(
      'SELECT id FROM users WHERE coach_id = $1 AND deletable = false LIMIT 1',
      [req.params.id]
    );
    if (blocked.length > 0) {
      return res.status(409).json({ error: 'Cannot delete coach with non-deletable users' });
    }

    const { rows } = await pool.query(
      'DELETE FROM coaches WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
    res.json({ deleted: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
