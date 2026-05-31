// Swap to a different platform by changing this constant and replacing this file.
const PLATFORM_ADAPTER = 'trainerize';

const BASE_URL = 'https://api.trainerize.com/v1';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function authHeader({ trainerId, apiKey }) {
  const encoded = Buffer.from(`${trainerId}:${apiKey}`).toString('base64');
  return `Basic ${encoded}`;
}

async function request(credentials, method, path, body) {
  const options = {
    method,
    headers: {
      Authorization: authHeader(credentials),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, options);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trainerize ${method} ${path} failed: ${res.status} ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const get  = (creds, path)        => request(creds, 'GET',   path);
const post = (creds, path, body)  => request(creds, 'POST',  path, body);
const put  = (creds, path, body)  => request(creds, 'PUT',   path, body);

// ---------------------------------------------------------------------------
// Public adapter functions
// ---------------------------------------------------------------------------

/**
 * Fetches all active coaching clients for a coach.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 */
async function getClients(coachCredentials) {
  return get(coachCredentials, '/clients?status=active');
}

/**
 * Fetches weight log history for a specific client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 */
async function getClientWeightLogs(coachCredentials, clientId) {
  return get(coachCredentials, `/clients/${clientId}/weightlogs`);
}

/**
 * Fetches the current meal/nutrition plan for a client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 */
async function getClientNutritionPlan(coachCredentials, clientId) {
  return get(coachCredentials, `/clients/${clientId}/nutritionplan`);
}

/**
 * Fetches the current workout program for a client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 */
async function getClientWorkoutPlan(coachCredentials, clientId) {
  return get(coachCredentials, `/clients/${clientId}/workoutprogram`);
}

/**
 * Pushes an updated meal/nutrition plan to a client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 * @param {object} planData
 */
async function updateNutritionPlan(coachCredentials, clientId, planData) {
  return put(coachCredentials, `/clients/${clientId}/nutritionplan`, planData);
}

/**
 * Pushes an updated workout program to a client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 * @param {object} planData
 */
async function updateWorkoutPlan(coachCredentials, clientId, planData) {
  return put(coachCredentials, `/clients/${clientId}/workoutprogram`, planData);
}

/**
 * Fetches message history between coach and client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 */
async function getMessages(coachCredentials, clientId) {
  return get(coachCredentials, `/clients/${clientId}/messages`);
}

/**
 * Sends a message to a client.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 * @param {string} message
 */
async function sendMessage(coachCredentials, clientId, message) {
  return post(coachCredentials, `/clients/${clientId}/messages`, { message });
}

/**
 * Fetches completed workout session logs for a client.
 * Returns sessions with exercise-level detail: name, sets, reps, weight, completedAt.
 * @param {{ trainerId: string, apiKey: string }} coachCredentials
 * @param {string|number} clientId
 */
async function getWorkoutLogs(coachCredentials, clientId) {
  return get(coachCredentials, `/clients/${clientId}/workoutlogs`);
}

// ---------------------------------------------------------------------------

module.exports = {
  PLATFORM_ADAPTER,
  getClients,
  getClientWeightLogs,
  getClientNutritionPlan,
  getClientWorkoutPlan,
  updateNutritionPlan,
  updateWorkoutPlan,
  getMessages,
  sendMessage,
  getWorkoutLogs,
};
