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

  const results = { scanned: clients.length, flagged: [], errors: [] };

  console.log(`[WorkoutMonitor] Starting scan for coach ${coachId}, ${clients.length} clients`);

  for (const client of clients) {
    console.log(`[WorkoutMonitor] Scanning ${client.name} (${client.id})`);
    try {
      const summary = await getClientSummaryWithRetry(creds, client.id);
      const workoutsByWeek = summary?.workoutsByWeek ?? [];

      if (workoutsByWeek[0] !== 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      const existing = await pool.query(
        `SELECT id FROM queue_items WHERE coach_id = $1 AND agent = 'workout-monitor' AND client_name = $2 AND created_at > NOW() - INTERVAL '24 hours'`,
        [coachId, client.name]
      );
      if (existing.rows.length > 0) {
        console.log(`[WorkoutMonitor] Skipping ${client.name} — already queued today`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `You draft check-in messages on behalf of a fitness coach.

COACH STYLE GUIDE:
${styleProfile}

Write a brief 2-sentence coach note to ${client.name} flagging that they have completed zero workouts so far this week. No markdown, no headers. Start directly with the message. Match the coach's voice from the style guide above.`,
          },
        ],
      });

      const draft = msg.content[0].text;
      const preview = `No workouts this week — ${client.name}`;
      const autoSend = settings.autonomous && 80 >= settings.threshold;

      await pool.query(
        `INSERT INTO queue_items (coach_id, agent, client_name, client_id, preview, draft, original_draft, auto_send)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
        [coachId, 'workout-monitor', client.name, client.id.toString(), preview, draft, autoSend]
      );

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
