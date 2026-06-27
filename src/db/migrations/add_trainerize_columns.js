const pool = require('../index');

async function run() {
  try {
    await pool.query('ALTER TABLE coaches ADD COLUMN IF NOT EXISTS trainerize_api_key TEXT');
    await pool.query('ALTER TABLE coaches ADD COLUMN IF NOT EXISTS trainerize_trainer_id TEXT');
    console.log('Migration complete: added trainerize_api_key and trainerize_trainer_id to coaches');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
