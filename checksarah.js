require('dotenv').config();
const t = require('./src/services/trainerize');
const creds = { groupId: '612647', apiKey: 'FXIfOXgHo0OoMJ3bAOPyVA' };
t.getClients(creds)
  .then(d => {
    const sarah = d.users.find(u => (u.name || '').toLowerCase().includes('sarah'));
    if (sarah === undefined) {
      console.log('Not found. All names:', d.users.map(u => u.name).join(', '));
      return;
    }
    console.log('Found:', sarah.name, sarah.id);
    return t.getClientSummary(creds, sarah.id).then(s => {
      console.log('workoutsByWeek:', JSON.stringify(s.workoutsByWeek));
      console.log('scheduledByWeek:', JSON.stringify(s.scheduledByWeek));
      console.log('workoutsTotal:', s.workoutsTotal);
      console.log('workoutsUpcomingScheduled:', s.workoutsUpcomingScheduled);
    });
  })
  .catch(e => console.error('Error:', e.message));
