const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const trainerize = require('../services/trainerize');
const { getStyleProfile } = require('./managingAgent');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getAgentSettings(coachId) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_settings WHERE coach_id = $1 AND agent = 'messaging'`,
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

async function draftResponse(coachId, clientId, incomingMessage) {
  const [settings, creds, styleProfile] = await Promise.all([
    getAgentSettings(coachId),
    getTrainerizeCredentials(coachId),
    getStyleProfile(coachId),
  ]);

  const [historyResult, clientRow] = await Promise.all([
    trainerize.getMessages(creds, clientId),
    pool.query(
      `SELECT name FROM clients WHERE id = $1 AND coach_id = $2`,
      [clientId, coachId]
    ),
  ]);

  const clientName = clientRow.rows[0]?.name || `Client #${clientId}`;

  const recentHistory = Array.isArray(historyResult?.messages)
    ? historyResult.messages
        .slice(-10)
        .map((m) => `${m.sender}: ${m.text}`)
        .join('\n')
    : 'No prior message history available.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: `You draft replies on behalf of a fitness coach to their client.

COACH STYLE GUIDE:
${styleProfile}

RULES:
- Write entirely in the coach's voice using the style guide above.
- Address the client by first name.
- Be specific and actionable. Avoid filler.
- Respond with valid JSON only:
  { "draft": "<full reply>", "preview": "<first 120 chars of reply>", "confidence": <0-100> }
- confidence = certainty that this reply is appropriate as-is without coach review (0 = needs review, 100 = send immediately).`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Client: ${clientName}

Recent message history:
${recentHistory}

New message from client:
"${incomingMessage}"

Draft a reply.`,
      },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(response.content[0].text);
  } catch {
    const text = response.content[0].text;
    parsed = { draft: text, preview: text.slice(0, 120), confidence: 65 };
  }

  const { draft, preview, confidence = 65 } = parsed;
  const autoSend = settings.autonomous && confidence >= settings.threshold;

  await pool.query(
    `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [coachId, 'messaging', clientName, preview, draft, autoSend]
  );

  return { draft, preview, confidence, autoSend, clientName };
}

module.exports = { draftResponse };
