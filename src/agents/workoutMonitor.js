const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const trainerize = require('../services/trainerize');
const { getStyleProfile } = require('./managingAgent');

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

async function getClientSummaryWithRetry(creds, clientId) {
  const delays = [5000, 10000, 20000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await trainerize.getClientSummary(creds, clientId);
    } catch (err) {
      lastErr = err;
      const isRetryable = err.message.includes('rate limit or HTML')
        || err.message.includes('500')
        || err instanceof SyntaxError;
      if (attempt < delays.length && isRetryable) {
        const wait = delays[attempt];
        console.warn(`[WorkoutMonitor] Retryable error for client ${clientId} (attempt ${attempt + 1}/${delays.length}, wait ${wait / 1000}s): ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, wait));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function scanWorkoutCompliance(coachId) {
  const [settings, creds, styleProfile] = await Promise.all([
    getAgentSettings(coachId),
    getTrainerizeCredentials(coachId),
    getStyleProfile(coachId),
  ]);

  const data = await trainerize.getClients(creds);
  const clients = (data?.users ?? []).map(u => ({
    id:   u.id,
    name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || `Client #${u.id}`,
  }));

  const missedWorkoutDays = settings.missed_workout_days ?? 7;

  const results = { scanned: clients.length, flagged: [], errors: [] };

  console.log(`[WorkoutMonitor] Starting scan for coach ${coachId}, ${clients.length} clients`);

  for (const client of clients) {
    try {
      const summary = await getClientSummaryWithRetry(creds, client.id);
      const workoutsByWeek = Array.isArray(summary?.workoutsByWeek) ? summary.workoutsByWeek : [];
      const workoutsTotal  = summary?.workoutsTotal ?? null;

      console.log(`[WorkoutMonitor] Scanning ${client.name} (${client.id}) — workoutsByWeek: [${workoutsByWeek.join(', ')}]`);

      // Not enough history to determine compliance — skip
      if (workoutsByWeek.length < 2) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      // Brand-new client with no workouts at all — skip
      const allZero = workoutsByWeek.every(w => w === 0);
      if (allZero && (workoutsTotal === 0 || workoutsTotal === null)) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      // Last completed week is index length-2; current (in-progress) week is last index
      const lastCompletedWeek = workoutsByWeek[workoutsByWeek.length - 2];
      if (lastCompletedWeek !== 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      const existing = await pool.query(
        `SELECT id, created_at FROM queue_items WHERE coach_id = $1 AND agent = 'workout-monitor' AND client_name = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [coachId, client.name]
      );

      const daysInactive = Math.round((Date.now() - new Date(existing.rows[0]?.created_at ?? Date.now()).getTime()) / (1000 * 60 * 60 * 24)) || 0;
      const dayLabel = existing.rows[0] ? `${daysInactive} day${daysInactive !== 1 ? 's' : ''}` : 'this week';

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `You draft check-in messages on behalf of a fitness coach.

COACH STYLE GUIDE:
${styleProfile}

Write a brief 2-sentence coach note to ${client.name} flagging that they have not completed any workouts in ${dayLabel}. No markdown, no headers. Start directly with the message. Match the coach's voice from the style guide above.`,
          },
        ],
      });

      const draft = msg.content[0].text;
      const preview = `No workouts this week — ${client.name}`;
      const autoSend = settings.autonomous && 80 >= settings.threshold;

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE queue_items SET draft = $1, preview = $2, created_at = NOW() WHERE id = $3`,
          [draft, preview, existing.rows[0].id]
        );
        console.log(`[WorkoutMonitor] Updated existing item for ${client.name} (${daysInactive}d inactive)`);
      } else {
        await pool.query(
          `INSERT INTO queue_items (coach_id, agent, client_name, client_id, preview, draft, original_draft, auto_send)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
          [coachId, 'workout-monitor', client.name, client.id.toString(), preview, draft, autoSend]
        );
      }

      results.flagged.push({ clientId: client.id, clientName: client.name, reason: 'no-workouts-this-week' });
      console.log(`[WorkoutMonitor] Flagged ${client.name}: no-workouts-this-week`);
    } catch (err) {
      results.errors.push({ clientId: client.id, clientName: client.name, error: err.message });
      console.error(`[WorkoutMonitor] Error ${client.name}: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log(`[WorkoutMonitor] Scan complete — scanned: ${results.scanned}, flagged: ${results.flagged.length}, errors: ${results.errors.length}`);

  return results;
}

module.exports = { scanWorkoutCompliance };
