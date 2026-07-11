const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const trainerize = require('../services/trainerize');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Used by generateAdjustment which reasons about existing plans
const MEAL_PLAN_SYSTEM = `You are an expert nutrition coach. Write like a coach talking directly to the client — use "you", not "the client". Conversational and encouraging. No clinical language, no generic disclaimers.`;

// Used by generatePlan — concise macro summary only
const MACRO_SUMMARY_SYSTEM = `You are an expert nutrition coach sending a client their macro targets. Write 2-3 sentences of direct coaching context, then present the numbers clearly. No food lists, no grocery lists, no restaurant options, no mindset sections. Plain text only — no markdown headers, no bullet symbols beyond a simple dash. Keep the entire response under 200 words.`;

async function getAgentSettings(coachId) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_settings WHERE coach_id = $1 AND agent = 'meal-plan'`,
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

async function generatePlan(coachId, clientId, clientStats) {
  const [settings] = await Promise.all([getAgentSettings(coachId)]);

  const clientName = clientStats.name || `Client #${clientId}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: [{ type: 'text', text: MACRO_SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Write a brief coaching note for ${clientName} explaining their new macro targets and why they're set this way.

Goal: ${clientStats.goal}
Current weight: ${clientStats.currentWeight} lbs → Target: ${clientStats.targetWeight} lbs
Activity: ${clientStats.activity || 'moderate'} | Training days/week: ${clientStats.trainingDays || 4}
Dietary restrictions: ${clientStats.restrictions?.join(', ') || 'none'}${clientStats.notes ? `\nNotes: ${clientStats.notes}` : ''}

Targets:
- Daily calories: ${clientStats.dailyCalories} kcal
- Protein: ${clientStats.protein}g | Carbs: ${clientStats.carbs}g | Fat: ${clientStats.fat}g
- Training days: ${clientStats.dailyCalories} kcal | Rest days: ${Math.round(clientStats.dailyCalories * 0.85)} kcal`,
      },
    ],
  });

  const draft = response.content[0].text;
  const preview = `Macro targets — ${clientName} | ${clientStats.dailyCalories} kcal / ${clientStats.protein}g protein`;

  const autoSend = settings.autonomous && 90 >= settings.threshold;

  const macroMeta = {
    caloricGoal:     clientStats.dailyCalories,
    proteinGrams:    clientStats.protein,
    carbsGrams:      clientStats.carbs,
    fatGrams:        clientStats.fat,
    proteinPercent:  Math.round((clientStats.protein * 4 / clientStats.dailyCalories) * 100),
    carbsPercent:    Math.round((clientStats.carbs * 4 / clientStats.dailyCalories) * 100),
    fatPercent:      Math.round((clientStats.fat * 9 / clientStats.dailyCalories) * 100),
  };

  await pool.query(
    `INSERT INTO queue_items (coach_id, agent, client_name, client_id, preview, draft, auto_send, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [coachId, 'meal-plan', clientName, clientId.toString(), preview, draft, autoSend, JSON.stringify(macroMeta)]
  );

  return { draft, preview, autoSend, clientName };
}

async function generateAdjustment(coachId, clientId, weightData) {
  const [settings, creds] = await Promise.all([
    getAgentSettings(coachId),
    getTrainerizeCredentials(coachId),
  ]);

  const [clientsData, existingPlan] = await Promise.all([
    trainerize.getClients(creds),
    trainerize.getClientNutritionPlan(creds, clientId),
  ]);

  const match = (clientsData?.users ?? []).find(u => String(u.id) === String(clientId));
  const clientName = match
    ? `${match.firstName ?? ''} ${match.lastName ?? ''}`.trim() || `Client #${clientId}`
    : `Client #${clientId}`;

  const weightSummary = (weightData.logs || [])
    .map((l) => `  ${l.date}: ${l.weight} lbs`)
    .join('\n');

  const trendLine = `Trend: ${weightData.trend || 'flat'} | Avg weekly change: ${weightData.weeklyChange > 0 ? '+' : ''}${weightData.weeklyChange} lbs/wk`;
  const plateauLine = weightData.plateauWeeks
    ? `Plateau: no meaningful change for ${weightData.plateauWeeks} weeks`
    : '';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: [
      {
        type: 'text',
        text: `${MEAL_PLAN_SYSTEM}

════════════════════════════════════════
ADJUSTMENT MODE
════════════════════════════════════════
You are making targeted changes to an existing plan — NOT generating a new one.

ALWAYS start with:
=== WHAT CHANGED & WHY ===
• [change 1]: [reason]
• [change 2]: [reason]
...

Then show only the modified meals/days, clearly labelled [UPDATED].
State the old value and new value for any macro or calorie change.
Leave unchanged meals exactly as they are — do not reprint them.`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Client: ${clientName}

WEIGHT LOG (recent weeks):
${weightSummary}

${trendLine}
${plateauLine}

CURRENT MEAL PLAN:
${typeof existingPlan === 'string' ? existingPlan : JSON.stringify(existingPlan, null, 2)}

Generate a targeted adjustment based on the weight trend.`,
      },
    ],
  });

  const draft = response.content[0].text;
  const reason = weightData.plateauWeeks
    ? `${weightData.plateauWeeks}-week plateau`
    : `weight trend: ${weightData.trend}`;
  const preview = `Meal plan adjustment — ${clientName} | ${reason}`;

  const autoSend = settings.autonomous && 85 >= settings.threshold;

  const adjustmentMeta = {
    adjustmentReason: weightData.plateauWeeks ? 'plateau' : (weightData.trend ?? 'unknown'),
    plateauWeeks:     weightData.plateauWeeks ?? null,
    weeklyChange:     weightData.weeklyChange ?? null,
    trend:            weightData.trend ?? null,
  };

  await pool.query(
    `INSERT INTO queue_items (coach_id, agent, client_name, client_id, preview, draft, auto_send, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [coachId, 'meal-plan', clientName, clientId.toString(), preview, draft, autoSend, JSON.stringify(adjustmentMeta)]
  );

  return { draft, preview, autoSend, clientName };
}

module.exports = { generatePlan, generateAdjustment };
