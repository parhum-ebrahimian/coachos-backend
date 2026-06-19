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
  const { name, email, plan = 'free', subdomain, branding = {} } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO coaches (name, email, plan, subdomain, branding)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, email, plan, subdomain || null, JSON.stringify(branding)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email or subdomain already in use' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/coaches/:id — admin only
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['name', 'email', 'plan', 'subdomain', 'branding', 'status'];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  const setClauses = Object.keys(updates).map((k, i) => `"${k}" = $${i + 2}`);
  const values = [req.params.id, ...Object.values(updates)];

  try {
    const { rows } = await pool.query(
      `UPDATE coaches SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Coach not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email or subdomain already in use' });
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
