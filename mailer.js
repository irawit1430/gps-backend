// Email delivery. Mirrors firebase.js: silently inert when unconfigured, never throws,
// and a send failure must not fail the request that triggered it.
//
// Deliberately SMTP rather than a provider SDK. Amazon SES is about ₹9 per 1,000 mails
// and roughly ten times cheaper than the alternatives at this volume, but every one of
// them speaks SMTP — so the provider is a credential change, not a code change. If SES
// sandbox approval drags, point EMAIL_SMTP_* at Brevo for a week and swap back.
//
// COST NOTE, because it matters more than the provider:
// email is the expensive channel and push is free. Mailing every boarding scan for one
// 600-student school is ~26,400 mails a month; mailing only what a parent must act on
// is closer to 1,000. The second is both cheaper and far better received — a parent who
// filters routine mail to spam stops seeing the emergency mail too. Route routine
// events to push, and reserve email for exceptions, account mail and digests.

const nodemailer = require('nodemailer');
const config = require('./config');
const logger = require('./logger');

let transport = null;

if (config.EMAIL_SMTP_HOST && config.EMAIL_FROM) {
  transport = nodemailer.createTransport({
    host: config.EMAIL_SMTP_HOST,
    port: config.EMAIL_SMTP_PORT,
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: config.EMAIL_SMTP_PORT === 465,
    auth: config.EMAIL_SMTP_USER
      ? { user: config.EMAIL_SMTP_USER, pass: config.EMAIL_SMTP_PASS }
      : undefined,
  });
  logger.info({ host: config.EMAIL_SMTP_HOST, from: config.EMAIL_FROM }, 'Mailer configured');
} else {
  logger.warn('EMAIL_SMTP_HOST/EMAIL_FROM unset — email delivery disabled');
}

function isConfigured() {
  return Boolean(transport);
}

// Send one message. Returns true if handed to the provider, false if it was not sent
// for any reason — never throws, so a caller can fire and forget.
async function sendMail({ to, subject, text, html }) {
  if (!transport) return false;
  if (!to || !subject) return false;

  try {
    await transport.sendMail({
      from: config.EMAIL_FROM,
      to,
      subject,
      text,
      // Plain text is not optional. A mail with no text part scores badly with spam
      // filters, and this account's reputation carries the alerts that matter.
      html: html || undefined,
    });
    return true;
  } catch (err) {
    logger.error({ err: err.message, to, subject }, 'sendMail failed');
    return false;
  }
}

// Fan out to several recipients as separate messages rather than one mail with many
// To: addresses — parents must not see each other's email addresses.
async function sendMailTo(recipients, payload) {
  if (!transport) return { sent: 0, failed: 0 };
  const list = [...new Set((recipients || []).filter(Boolean))];
  let sent = 0;
  let failed = 0;
  for (const to of list) {
    // Sequential on purpose: SMTP providers rate-limit, and this is never on a hot
    // path — the volumes are exceptions and digests, not every scan.
    if (await sendMail({ ...payload, to })) sent += 1;
    else failed += 1;
  }
  if (failed > 0) logger.warn({ sent, failed }, 'some emails failed');
  return { sent, failed };
}

module.exports = { sendMail, sendMailTo, isConfigured };
