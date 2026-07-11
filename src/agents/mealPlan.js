const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const trainerize = require('../services/trainerize');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cached across calls — long prompt that stays stable
const MEAL_PLAN_SYSTEM = `You are an expert nutrition coach writing personalized meal plans for fitness clients.

════════════════════════════════════════
REQUIRED OUTPUT FORMAT — follow exactly
════════════════════════════════════════

1. HEADER
   ===== [CLIENT NAME]'S MEAL PLAN =====
   Goal: [goal]
   Daily Calories: [X] kcal  |  Protein: [X]g  |  Carbs: [X]g  |  Fat: [X]g

2. A / B / C DAY ROTATION
   • Day A = highest-carb training day
   • Day B = moderate training or active rest
   • Day C = lowest-carb rest day
   Each day has exactly 3 meals + 1 snack.

3. EACH FOOD ITEM:
   • [Brand or food name] ([Xg])  —  [X]P / [X]C / [X]F / [X] cal
   End each meal with:  MEAL TOTAL: [X]P / [X]C / [X]F / [X] cal
   End each day with:   DAY [A/B/C] TOTAL: [X]P | [X]C | [X]F | [X] kcal

4. GROCERY LIST  (after all 3 days)
   Sections: PROTEINS: | PRODUCE: | DAIRY & EGGS: | GRAINS & PANTRY: | SNACKS & EXTRAS:
   List each item with approximate weekly quantity.

5. EATING OUT & SOCIAL OPTIONS
   Give a specific order for each:
   → Chipotle  → Chick-fil-A  → Pizza  → Burgers  → Mexican (non-Chipotle)  → Pasta / Italian
   Format: "[Venue]: [exact order] — ~[X] cal, [X]P/[X]C/[X]F"

6. MINDSET RULES  (5–7 bullets)
   Practical, motivating principles about consistency, flexible eating, and momentum.

════════════════════════════════════════
VOICE & STYLE
════════════════════════════════════════
- Write like a coach talking directly to the client — use "you", not "the client".
- Conversational and encouraging. No clinical language, no generic disclaimers.
- Use real brand names where relevant: Kodiak Cakes, Oikos Triple Zero, Barebells protein bars,
  Goodles pasta, Quest bars, Fairlife milk/protein, Chobani, Dave's Killer Bread, etc.
- Gram measurements for all ingredients. No "medium banana" — use "banana (100g)".`;

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
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: [{ type: 'text', text: MEAL_PLAN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Generate a complete meal plan for:

Name: ${clientName}
Goal: ${clientStats.goal}
Daily calories: ${clientStats.dailyCalories} kcal
Protein: ${clientStats.protein}g | Carbs: ${clientStats.carbs}g | Fat: ${clientStats.fat}g
Current weight: ${clientStats.currentWeight} lbs
Target weight: ${clientStats.targetWeight} lbs
Activity level: ${clientStats.activity || 'moderate'}
Training days/week: ${clientStats.trainingDays || 4}
Dietary restrictions: ${clientStats.restrictions?.join(', ') || 'none'}${clientStats.notes ? `\nNotes: ${clientStats.notes}` : ''}`,
      },
    ],
  });

  const draft = response.content[0].text;
  const preview = `New meal plan — ${clientName} | ${clientStats.dailyCalories} kcal / ${clientStats.protein}g protein`;

  // Full plans use a fixed high-confidence value; require explicit autonomous mode to skip review
  const autoSend = settings.autonomous && 90 >= settings.threshold;

  await pool.query(
    `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [coachId, 'meal-plan', clientName, preview, draft, autoSend]
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
    model: 'claude-sonnet-4-20250514',
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

  await pool.query(
    `INSERT INTO queue_items (coach_id, agent, client_name, preview, draft, auto_send)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [coachId, 'meal-plan', clientName, preview, draft, autoSend]
  );

  return { draft, preview, autoSend, clientName };
}

module.exports = { generatePlan, generateAdjustment };
