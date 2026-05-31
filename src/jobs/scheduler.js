const cron = require('node-cron');
const pool = require('../db');
const progressMonitor = require('../agents/progressMonitor');
const workoutMonitor  = require('../agents/workoutMonitor');

// coachId (number) → { task: CronTask, expression: string, timezone: string }
const coachJobs = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseCronTime(timeStr) {
  const [h, m] = (timeStr || '08:00').split(':').map(Number);
  return { hour: isNaN(h) ? 8 : h, minute: isNaN(m) ? 0 : m };
}

function buildCronExpression(schedule) {
  const { hour, minute } = parseCronTime(schedule.time);

  if (schedule.frequency === 'daily') {
    return `${minute} ${hour} * * *`;
  }

  if (schedule.frequency === 'custom' && Array.isArray(schedule.days) && schedule.days.length > 0) {
    const nums = schedule.days
      .map(d => DAY_NAMES.indexOf(d.toLowerCase()))
      .filter(n => n !== -1)
      .join(',');
    if (!nums) return null;
    return `${minute} ${hour} * * ${nums}`;
  }

  // Default: weekly on Monday
  const day = Array.isArray(schedule.days) && schedule.days.length
    ? Math.max(0, DAY_NAMES.indexOf(schedule.days[0].toLowerCase()))
    : 1;
  return `${minute} ${hour} * * ${day}`;
}

async function runCoachScan(coachId) {
  console.log(`[Scheduler] Running scan for coach ${coachId}`);
  try {
    await Promise.all([
      progressMonitor.scanClients(coachId),
      workoutMonitor.scanWorkoutCompliance(coachId),
      workoutMonitor.scanProgressiveOverload(coachId),
    ]);
    console.log(`[Scheduler] Scan complete for coach ${coachId}`);
  } catch (err) {
    console.error(`[Scheduler] Scan error for coach ${coachId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Per-coach job management
// ---------------------------------------------------------------------------

function cancelCoachJob(coachId) {
  if (coachJobs.has(coachId)) {
    coachJobs.get(coachId).task.stop();
    coachJobs.delete(coachId);
  }
}

function scheduleCoachJob(coachId, schedule) {
  cancelCoachJob(coachId);

  if (!schedule?.enabled) return;

  // Daily-frequency coaches are handled by the midnight sweep — no redundant per-coach job needed
  if (schedule.frequency === 'daily') return;

  const expr = buildCronExpression(schedule);
  if (!expr || !cron.validate(expr)) {
    console.warn(`[Scheduler] Invalid schedule for coach ${coachId} (expr="${expr}")`);
    return;
  }

  const tz = schedule.timezone || 'UTC';
  const task = cron.schedule(expr, () => runCoachScan(coachId), { timezone: tz });
  coachJobs.set(coachId, { task, expression: expr, timezone: tz });
  console.log(`[Scheduler] Coach ${coachId} scheduled: "${expr}" (tz: ${tz})`);
}

// ---------------------------------------------------------------------------
// Midnight daily sweep
//  - Runs all daily-frequency coaches immediately
//  - Re-syncs all per-coach jobs from the DB (catches settings changed without a hot-reload call)
// ---------------------------------------------------------------------------

function startDailySweep() {
  cron.schedule('0 0 * * *', async () => {
    console.log('[Scheduler] Midnight sweep starting');

    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT id, branding->'scanSchedule' AS scan_schedule FROM coaches`
      ));
    } catch (err) {
      console.error('[Scheduler] Failed to load coaches for midnight sweep:', err.message);
      return;
    }

    const dailyRuns = [];

    for (const row of rows) {
      const schedule = row.scan_schedule;

      // Re-sync per-coach job (picks up any DB changes that bypassed updateCoachSchedule)
      scheduleCoachJob(row.id, schedule);

      // Run immediately at midnight for daily-frequency coaches
      if (schedule?.enabled && schedule.frequency === 'daily') {
        dailyRuns.push(runCoachScan(row.id));
      }
    }

    await Promise.allSettled(dailyRuns);
    console.log(`[Scheduler] Midnight sweep complete — ${dailyRuns.length} daily scan(s) triggered`);
  }, { timezone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Startup: load all schedules from DB and create per-coach jobs
// ---------------------------------------------------------------------------

async function loadAllSchedules() {
  const { rows } = await pool.query(
    `SELECT id, branding->'scanSchedule' AS scan_schedule FROM coaches`
  );
  let loaded = 0;
  for (const row of rows) {
    if (row.scan_schedule?.enabled) {
      scheduleCoachJob(row.id, row.scan_schedule);
      loaded++;
    }
  }
  console.log(`[Scheduler] Loaded ${loaded} active schedule(s) from ${rows.length} coach(es)`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Re-reads a single coach's scan schedule from the DB and recreates their cron job.
 * Call this from the settings API after a coach updates their scan schedule.
 */
async function updateCoachSchedule(coachId) {
  const { rows } = await pool.query(
    `SELECT branding->'scanSchedule' AS scan_schedule FROM coaches WHERE id = $1`,
    [coachId]
  );
  if (!rows[0]) {
    cancelCoachJob(coachId);
    return;
  }
  scheduleCoachJob(coachId, rows[0].scan_schedule);
}

/**
 * Starts the scheduler. Call once from server.js on startup.
 */
function startScheduler() {
  loadAllSchedules().catch(err =>
    console.error('[Scheduler] Startup load failed:', err.message)
  );
  startDailySweep();
  console.log('[Scheduler] Started');
}

function getStatus() {
  const jobs = [];
  for (const [coachId, { expression, timezone }] of coachJobs) {
    jobs.push({ coachId, expression, timezone });
  }
  return { running: true, activeJobs: coachJobs.size, jobs };
}

module.exports = { startScheduler, updateCoachSchedule, getStatus };
