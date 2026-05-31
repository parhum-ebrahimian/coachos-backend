const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

// GET /api/clients — scoped to coach; admin can pass ?coach_id=
router.get('/', async (req, res) => {
  try {
    let coachId;
    if (req.user.role === 'admin') {
      coachId = req.query.coach_id ? parseInt(req.query.coach_id, 10) : null;
    } else {
      coachId = req.user.coach_id;
    }

    const { rows } = coachId
      ? await pool.query('SELECT * FROM clients WHERE coach_id = $1 ORDER BY id', [coachId])
      : await pool.query('SELECT * FROM clients ORDER BY id');

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    if (req.user.role !== 'admin' && rows[0].coach_id !== req.user.coach_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
