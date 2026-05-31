const nodemailer = require('nodemailer');
const pool = require('../db');

async function sendSlack(webhookUrl, message) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

async function sendEmail({ gmailUser, gmailPass, emailTo }, subject, message) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass },
  });
  await transporter.sendMail({
    from: gmailUser,
    to: emailTo,
    subject,
    text: message,
  });
}

async function sendNotification(coachId, message, subject = 'CoachOS Notification') {
  const { rows } = await pool.query(
    `SELECT branding->'notifications' AS notifications FROM coaches WHERE id = $1`,
    [coachId]
  );

  if (!rows[0]) throw new Error(`Coach ${coachId} not found`);

  const config = rows[0].notifications;
  if (!config || !config.channel) {
    throw new Error(`No notification channel configured for coach ${coachId}`);
  }

  if (config.channel === 'slack') {
    if (!config.slackWebhook) throw new Error('Slack webhook URL not configured');
    await sendSlack(config.slackWebhook, message);
  } else if (config.channel === 'email') {
    if (!config.gmailUser || !config.gmailPass || !config.emailTo) {
      throw new Error('Email credentials incomplete (requires gmailUser, gmailPass, emailTo)');
    }
    await sendEmail(config, subject, message);
  } else {
    throw new Error(`Unknown notification channel: ${config.channel}`);
  }
}

module.exports = { sendNotification };
