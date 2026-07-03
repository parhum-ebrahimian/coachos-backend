const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const trainerize = require('../services/trainerize');

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

    if (!coachId) {
      return res.json([]);
    }

    const { rows: coaches } = await pool.query(
      'SELECT trainerize_trainer_id, trainerize_api_key FROM coaches WHERE id = $1',
      [coachId]
    );
    const coach = coaches[0];

    if (!coach?.trainerize_trainer_id || !coach?.trainerize_api_key) {
      console.warn(`[clients] Coach ${coachId} missing Trainerize credentials`);
      return res.json([]);
    }

    const credentials = { groupId: coach.trainerize_trainer_id, apiKey: coach.trainerize_api_key };
    const data = await trainerize.getClients(credentials);

    const clients = (data?.users ?? []).map(user => ({
      id:              user.id,
      trainerize_id:   user.id,
      name:            `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
      firstName:       user.firstName,
      lastName:        user.lastName,
      email:           user.email,
      phoneNumber:     user.phoneNumber,
      status:          user.status,
      isActive:        user.isActive,
      mealPlan:        user.mealPlan,
      trainingPlan:    user.trainingPlan,
      created:         user.created,
      latestSignedIn:  user.latestSignedIn,
    }));

    res.json(clients);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/weight — weight history from Trainerize
router.get('/:id/weight', async (req, res) => {
  try {
    let coachId;
    if (req.user.role === 'admin') {
      coachId = req.query.coach_id ? parseInt(req.query.coach_id, 10) : null;
    } else {
      coachId = req.user.coach_id;
    }

    if (!coachId) return res.json([]);

    const { rows: coaches } = await pool.query(
      'SELECT trainerize_trainer_id, trainerize_api_key FROM coaches WHERE id = $1',
      [coachId]
    );
    const coach = coaches[0];

    if (!coach?.trainerize_trainer_id || !coach?.trainerize_api_key) {
      console.warn(`[clients/weight] Coach ${coachId} missing Trainerize credentials`);
      return res.json([]);
    }

    const credentials = { groupId: coach.trainerize_trainer_id, apiKey: coach.trainerize_api_key };
    const bodystats = await trainerize.getClientWeightLogs(credentials, req.params.id);

    const filtered = bodystats
      .filter(entry => entry.weight > 0 && entry.isProjected === false)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/summary — full client detail for the detail panel
router.get('/:id/summary', async (req, res) => {
  try {
    let coachId;
    if (req.user.role === 'admin') {
      coachId = req.query.coach_id ? parseInt(req.query.coach_id, 10) : null;
    } else {
      coachId = req.user.coach_id;
    }

    if (!coachId) return res.status(400).json({ error: 'coach_id is required' });

    const { rows: coaches } = await pool.query(
      'SELECT trainerize_trainer_id, trainerize_api_key FROM coaches WHERE id = $1',
      [coachId]
    );
    const coach = coaches[0];

    if (!coach?.trainerize_trainer_id || !coach?.trainerize_api_key) {
      return res.status(400).json({ error: 'Coach missing Trainerize credentials' });
    }

    const credentials = { groupId: coach.trainerize_trainer_id, apiKey: coach.trainerize_api_key };
    const clientId = req.params.id;

    const [summary, messagesResult] = await Promise.allSettled([
      trainerize.getClientSummary(credentials, clientId),
      trainerize.getMessages(credentials, clientId),
    ]);

    const data = summary.status === 'fulfilled' ? summary.value : null;
    if (summary.status === 'rejected') {
      return res.status(502).json({ error: summary.reason?.message ?? 'Failed to fetch client summary' });
    }

    const bodystats = (data?.bodystats ?? [])
      .filter(e => e.weight > 0 && e.isProjected === false)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const messages = messagesResult.status === 'fulfilled'
      ? (messagesResult.value?.messages ?? []).slice(-10)
      : [];

    if (messagesResult.status === 'rejected') {
      console.warn(`[clients/summary] getMessages failed for client ${clientId}:`, messagesResult.reason?.message);
    }

    res.json({
      id:               clientId,
      bodystats,
      lastWeight:       data?.lastWeight ?? null,
      lastWeightDate:   data?.lastWeightDate ?? null,
      workoutsByWeek:   data?.workoutsByWeek ?? null,
      nutritionByWeek:  data?.nutritionByWeek ?? null,
      mealPlan:         data?.mealPlan ?? null,
      program:          data?.program ?? null,
      goal:             data?.goal ?? null,
      messages,
    });
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
