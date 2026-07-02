const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const trainerize = require('../services/trainerize');
const mealPlan = require('./mealPlan');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MISSING_WEIGH_IN_DAYS = 7;
const PLATEAU_MIN_WEEKS = 3;
const PLATEAU_THRESHOLD_LBS = 1.0;

async function getAgentSettings(coachId) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_settings WHERE coach_id = $1 AND agent = 'progress-monitor'`,
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

function isMissingWeighIn(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return true;
  const latest = new Date(logs[logs.length - 1].date);
  const daysSince = (Date.now() - latest.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > MISSING_WEIGH_IN_DAYS;
}

function detectPlateau(logs) {
  if (!Array.isArray(logs) || logs.length < PLATEAU_MIN_WEEKS) return null;
  const recent = logs.slice(-PLATEAU_MIN_WEEKS);
  const first = recent[0].weight;
  const last = recent[recent.length - 1].weight;
  if (Math.abs(last - first) >= PLATEAU_THRESHOLD_LBS) return null;

  const avgWeight = (recent.reduce((s, l) => s + l.weight, 0) / recent.length).toFixed(1);
  const weeklyChange = ((last - first) / PLATEAU_MIN_WEEKS).toFixed(2);
  const trend = last > first ? 'gaining' : last < first ? 'losing' : 'flat';

  return { plateauWeeks: PLATEAU_MIN_WEEKS, averageWeight: avgWeight, weeklyChange: parseFloat(weeklyChange), trend, logs: recent };
}

async function scanClients(coachId) {
  const [settings, creds] = await Promise.all([
    getAgentSettings(coachId),
    getTrainerizeCredentials(coachId),
  ]);

  const data = await trainerize.getClients(creds);
  const clients = (data?.users ?? []).map(u => ({
    id:   u.id,
    name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.name || `Client #${u.id}`,
  }));

  const results = { scanned: clients.length, flagged: [], plateaus: [], errors: [] };

  await Promise.all(
    clients.map(async (client) => {
      try {
        const logsResponse = await trainerize.getClientWeightLogs(creds, client.id);
        const logs = logsResponse?.logs ?? logsResponse ?? [];

        if (isMissingWeighIn(logs)) {
          const msg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [
              {
                role: 'user',
                content: `Write a 2-sentence coach note flagging that ${client.name} hasn't logged their weight in over ${MISSING_WEIGH_IN_DAYS} days. Suggest reaching out to check in. Keep it warm and brief.`,
              },
            ],
          });

          const draft = msg.content[0].text;
          const autoSend = settings.autonomous && 80 >= settings.threshold;

          await pool.query(
            `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [coachId, 'progress-monitor', client.name, `Missing weigh-in — ${client.name}`, draft, autoSend]
          );

          results.flagged.push({ clientId: client.id, clientName: client.name, reason: 'missing-weigh-in' });
        }

        const plateau = detectPlateau(logs);
        if (plateau) {
          await mealPlan.generateAdjustment(coachId, client.id, plateau);
          results.plateaus.push({ clientId: client.id, clientName: client.name, ...plateau });
        }
      } catch (err) {
        results.errors.push({ clientId: client.id, clientName: client.name, error: err.message });
      }
    })
  );

  return results;
}

module.exports = { scanClients };
