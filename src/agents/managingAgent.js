const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYNTHESIS_SYSTEM = `You analyze how a fitness coach edits AI-generated content to extract their communication preferences.
Output a concise style guide (under 300 words) that captures their voice — tone, vocabulary, sentence length,
emoji usage, formality, sign-off style, and any recurring patterns across message types.
Write the guide as direct instructions (e.g. "Keep replies under 4 sentences"), not as observations.
This guide is injected into other agents' system prompts, so make it immediately actionable.`;

async function recordEdit(coachId, agentType, original, edited) {
  await pool.query(
    `INSERT INTO style_edits (coach_id, agent_type, original, edited)
     VALUES ($1, $2, $3, $4)`,
    [coachId, agentType, original, edited]
  );
}

async function getStyleProfile(coachId) {
  const { rows } = await pool.query(
    `SELECT agent_type, original, edited
     FROM style_edits
     WHERE coach_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [coachId]
  );

  if (rows.length === 0) {
    return 'No style edits recorded yet. Use a warm, professional tone. Be concise and encouraging. Address the client by first name.';
  }

  const examples = rows
    .map((r) => `[${r.agent_type}]\nOriginal:\n${r.original}\n\nEdited to:\n${r.edited}`)
    .join('\n\n---\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: SYNTHESIS_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Here are ${rows.length} examples of how this coach edited AI-drafted content:\n\n${examples}\n\nWrite their style guide.`,
      },
    ],
  });

  return response.content[0].text;
}

module.exports = { recordEdit, getStyleProfile };
