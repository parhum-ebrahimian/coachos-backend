require('dotenv').config();
const express = require('express');
const cors    = require('cors');

// Routes
const authRoutes         = require('./src/routes/auth');
const coachRoutes        = require('./src/routes/coaches');
const clientRoutes       = require('./src/routes/clients');
const queueRoutes        = require('./src/routes/queue');
const settingsRoutes     = require('./src/routes/settings');
const agentRequestRoutes = require('./src/routes/agent-requests');

// Services & jobs
const pool               = require('./src/db');
const { startScheduler, getStatus: schedulerStatus } = require('./src/jobs/scheduler');

// Agents — imported here so the health check can confirm they all load
const agents = {
  managingAgent:   require('./src/agents/managingAgent'),
  messaging:       require('./src/agents/messaging'),
  mealPlan:        require('./src/agents/mealPlan'),
  progressMonitor: require('./src/agents/progressMonitor'),
  workoutMonitor:  require('./src/agents/workoutMonitor'),
};

const app = express();

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Health — unauthenticated, returns live status of all subsystems
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const health = {
    status:    'ok',
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    database:  { status: 'unknown' },
    scheduler: schedulerStatus(),
    agents:    {},
  };

  // Live DB ping
  try {
    await pool.query('SELECT 1');
    health.database = { status: 'ok' };
  } catch (err) {
    health.database = { status: 'error', error: err.message };
    health.status   = 'degraded';
  }

  // Agent export inventory
  for (const [name, mod] of Object.entries(agents)) {
    health.agents[name] = Object.keys(mod).filter(k => typeof mod[k] === 'function');
  }

  const code = health.status === 'ok' ? 200 : 503;
  res.status(code).json(health);
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use('/api/auth',           authRoutes);
app.use('/api/coaches',        coachRoutes);
app.use('/api/clients',        clientRoutes);
app.use('/api/queue',          queueRoutes);
app.use('/api/settings',       settingsRoutes);
app.use('/api/agent-requests', agentRequestRoutes);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CoachOS backend running on port ${PORT}`);
  startScheduler();
});
