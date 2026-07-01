const PLATFORM_ADAPTER = 'trainerize';

const BASE_URL = 'https://api.trainerize.com/v03';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function authHeader({ groupId, apiKey }) {
  const encoded = Buffer.from(`${groupId}:${apiKey}`).toString('base64');
  return `Basic ${encoded}`;
}

async function request(credentials, path, body = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(credentials),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trainerize POST ${path} failed: ${res.status} ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Public adapter functions
// ---------------------------------------------------------------------------

async function getTrainerList(credentials) {
  return request(credentials, '/User/getTrainerList', {});
}

async function getTrainerId(credentials) {
  const data = await getTrainerList(credentials);
  return data.users[0].id;
}

async function getClients(credentials) {
  const trainerId = await getTrainerId(credentials);
  return request(credentials, '/User/getList', { trainerId });
}

async function getClientSummary(credentials, clientId) {
  return request(credentials, '/User/getClientSummary', { userId: clientId, unitWeight: 'lbs' });
}

async function getClientWeightLogs(credentials, clientId) {
  const data = await getClientSummary(credentials, clientId);
  return data?.bodystats ?? [];
}

async function getThread(credentials, clientId) {
  const trainerId = await getTrainerId(credentials);
  const data = await request(credentials, '/message/getThread', {
    userId: trainerId,
    view: 'userList',
    threadID: null,
    recipients: [clientId],
  });
  return data.thread.threadID;
}

async function getMessages(credentials, clientId) {
  const threadId = await getThread(credentials, clientId);
  return request(credentials, '/message/getMessages', { threadId });
}

async function sendMessage(credentials, clientId, message) {
  const threadId = await getThread(credentials, clientId);
  return request(credentials, '/message/reply', { threadId, body: message, type: 'text' });
}

async function getClientNutritionPlan(credentials, clientId) {
  return request(credentials, `/clients/${clientId}/nutritionplan`, {});
}

async function getClientWorkoutPlan(credentials, clientId) {
  return request(credentials, `/clients/${clientId}/workoutprogram`, {});
}

async function updateNutritionPlan(credentials, clientId, planData) {
  return request(credentials, `/clients/${clientId}/nutritionplan`, planData);
}

async function updateWorkoutPlan(credentials, clientId, planData) {
  return request(credentials, `/clients/${clientId}/workoutprogram`, planData);
}

async function getWorkoutLogs(credentials, clientId) {
  return request(credentials, `/clients/${clientId}/workoutlogs`, {});
}

// ---------------------------------------------------------------------------

module.exports = {
  PLATFORM_ADAPTER,
  getTrainerList,
  getTrainerId,
  getThread,
  getClients,
  getClientSummary,
  getClientWeightLogs,
  getClientNutritionPlan,
  getClientWorkoutPlan,
  updateNutritionPlan,
  updateWorkoutPlan,
  getMessages,
  sendMessage,
  getWorkoutLogs,
};
