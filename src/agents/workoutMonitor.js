const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const trainerize = require('../services/trainerize');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getAgentSettings(coachId) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_settings WHERE coach_id = $1 AND agent = 'workout-monitor'`,
    [coachId]
  );
  return rows[0] || { autonomous: false, threshold: 80 };
}

async function getTrainerizeCredentials(coachId) {
  const { rows } = await pool.query(
    'SELECT trainerize_trainer_id, trainerize_api_key FROM coaches WHERE id = $1',
    [coachId]
  );
  if (!rows[0]?.trainerize_api_key) throw new Error(`No Trainerize credentials configured for coach ${coachId}`);
  return { groupId: rows[0].trainerize_trainer_id, apiKey: rows[0].trainerize_api_key };
}

function getWeekStart() {
  const now = new Date();
  now.setDate(now.getDate() - now.getDay());
  now.setHours(0, 0, 0, 0);
  return now;
}

// ---------------------------------------------------------------------------
// scanWorkoutCompliance — flags clients who missed assigned sessions this week
// ---------------------------------------------------------------------------
async function scanWorkoutCompliance(coachId) {
  const [settings, creds] = await Promise.all([
    getAgentSettings(coachId),
    getTrainerizeCredentials(coachId),
  ]);

  const data = await trainerize.getClients(creds);
  const clients = (data?.users ?? []).map(u => ({
    id:   u.id,
    name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.name || `Client #${u.id}`,
  }));

  const weekStart = getWeekStart();
  const results = { scanned: clients.length, flagged: [], errors: [] };

  await Promise.all(
    clients.map(async (client) => {
      try {
        const [program, logs] = await Promise.all([
          trainerize.getClientWorkoutPlan(creds, client.id),
          trainerize.getWorkoutLogs(creds, client.id),
        ]);

        const assignedThisWeek = (program?.sessions || []).filter(
          (s) => s.scheduledDate && new Date(s.scheduledDate) >= weekStart
        ).length;

        const completedThisWeek = (logs?.sessions || []).filter(
          (s) => s.completedAt && new Date(s.completedAt) >= weekStart && s.completed
        ).length;

        const missed = assignedThisWeek - completedThisWeek;
        if (missed <= 0) return;

        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 220,
          messages: [
            {
              role: 'user',
              content: `Write a brief, factual 2-sentence coach note flagging that ${client.name} missed ${missed} of ${assignedThisWeek} assigned workout session(s) this week. Keep it constructive, not judgmental.`,
            },
          ],
        });

        const draft = msg.content[0].text;
        const preview = `Missed workouts — ${client.name}: ${missed}/${assignedThisWeek} sessions this week`;
        const autoSend = settings.autonomous && 80 >= settings.threshold;

        await pool.query(
          `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [coachId, 'workout-monitor', client.name, preview, draft, autoSend]
        );

        results.flagged.push({ clientId: client.id, clientName: client.name, missed, assigned: assignedThisWeek });
      } catch (err) {
        results.errors.push({ clientId: client.id, clientName: client.name, error: err.message });
      }
    })
  );

  return results;
}

// ---------------------------------------------------------------------------
// scanProgressiveOverload — flags exercises stalled at the same weight for 2+ consecutive sessions
// ---------------------------------------------------------------------------
async function scanProgressiveOverload(coachId) {
  const [settings, creds] = await Promise.all([
    getAgentSettings(coachId),
    getTrainerizeCredentials(coachId),
  ]);

  const { rows: clients } = await pool.query(
    `SELECT id, name FROM clients WHERE coach_id = $1 AND status = 'active'`,
    [coachId]
  );

  const results = { scanned: clients.length, flagged: [], errors: [] };

  await Promise.all(
    clients.map(async (client) => {
      try {
        const logs = await trainerize.getWorkoutLogs(creds, client.id);
        const sessions = (logs?.sessions || []).sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        );

        // Build per-exercise history: { exerciseName: [{date, weight, sets, reps}, ...] }
        const exerciseHistory = {};
        for (const session of sessions) {
          for (const ex of session.exercises || []) {
            if (!exerciseHistory[ex.name]) exerciseHistory[ex.name] = [];
            exerciseHistory[ex.name].push({
              date: session.date,
              weight: ex.weight,
              sets: ex.sets,
              reps: ex.reps,
            });
          }
        }

        // Detect consecutive sessions at the same weight
        const stalled = [];
        for (const [name, history] of Object.entries(exerciseHistory)) {
          if (history.length < 2) continue;
          let streak = 1;
          for (let i = history.length - 1; i > 0; i--) {
            if (history[i].weight === history[i - 1].weight) {
              streak++;
            } else {
              break;
            }
          }
          if (streak >= 2) {
            const last = history[history.length - 1];
            stalled.push({ exercise: name, currentWeight: last.weight, sets: last.sets, reps: last.reps, consecutiveSessions: streak });
          }
        }

        if (stalled.length === 0) return;

        const stalledLines = stalled
          .map((s) => `• ${s.exercise}: ${s.currentWeight} lbs × ${s.sets}×${s.reps} — ${s.consecutiveSessions} consecutive sessions`)
          .join('\n');

        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [
            {
              role: 'user',
              content: `Write a brief coach note (3–4 sentences) flagging that ${client.name} has not increased weight on the following exercises across 2 or more consecutive sessions. List each exercise with the details shown. Suggest the coach review progressive overload opportunities.

Stalled exercises:
${stalledLines}`,
            },
          ],
        });

        const draft = msg.content[0].text;
        const preview = `Progressive overload stall — ${client.name}: ${stalled.length} exercise(s)`;
        const autoSend = settings.autonomous && 75 >= settings.threshold;

        await pool.query(
          `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [coachId, 'workout-monitor', client.name, preview, draft, autoSend]
        );

        results.flagged.push({ clientId: client.id, clientName: client.name, stalledExercises: stalled });
      } catch (err) {
        results.errors.push({ clientId: client.id, clientName: client.name, error: err.message });
      }
    })
  );

  return results;
}

module.exports = { scanWorkoutCompliance, scanProgressiveOverload };
