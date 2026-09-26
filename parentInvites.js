// Parent invites: how a family gets into the parent app.
//
// Before this, a new parent account came with a temporary password the office copied
// out of a popup ("Copy All" for an import of hundreds), or one shared opening password
// for the whole school. Either way the school could not say which families had been
// told, and one leaked slip opened other families' accounts.
//
// Now every family gets its own invite: the app link, their sign-in email and a one-time
// code that works for PARENT_INVITE_DAYS. The code is the account's password with
// mustResetPassword set, so the parent chooses their own on first sign-in and the code
// dies with it. Sending again replaces the code; revoking kills it.
//
// How it went out is recorded honestly. EMAIL is sent by this server, so a failure is
// known and shown. WHATSAPP, SMS, PRINT and COPY are handed over by school staff: the
// server knows the code was made for that channel, not that the family received it.
// Only signing in proves that.

const CHANNELS = ['EMAIL', 'WHATSAPP', 'SMS', 'PRINT', 'COPY'];
const STAFF_CHANNELS = CHANNELS.filter((c) => c !== 'EMAIL');

const DAY_MS = 24 * 60 * 60 * 1000;

// Where a family stands. Order matters: the first that is true wins.
function stageOf(user, now = new Date()) {
  if (!user.mustResetPassword) return 'ACTIVATED';
  if (user.inviteChannel === 'EMAIL_FAILED') return 'EMAIL_FAILED';
  if (user.inviteChannel === 'REVOKED') return 'NOT_INVITED';
  if (user.inviteSentAt) {
    if (user.inviteExpiresAt && new Date(user.inviteExpiresAt) < now) return 'INVITE_EXPIRED';
    // Signed in with the code but has not chosen a password yet: halfway through.
    if (user.lastLoginAt && new Date(user.lastLoginAt) >= new Date(user.inviteSentAt)) return 'SIGNED_IN';
    return 'INVITE_SENT';
  }
  // A parent given a temporary password before invites existed, who has used it.
  if (user.lastLoginAt) return 'SIGNED_IN';
  return 'NOT_INVITED';
}

// A family whose invite would be sent now. An activated parent chose their own password;
// replacing it with a code would lock them out, so they go through Reset password.
const canInvite = (user) => user.role === 'PARENT' && Boolean(user.mustResetPassword);

function expiryFor(days, now = new Date()) {
  return new Date(now.getTime() + days * DAY_MS);
}

function formatDate(d, timeZone = 'Asia/Kolkata') {
  try {
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(d);
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}

const listNames = (names) => {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] || 'your child';
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The words a family receives, whichever way it reaches them. One source, so the
 * email, the WhatsApp message and the printed letter never disagree.
 */
function inviteMessage({ parentName, email, code, schoolName, childNames, expiresAt, links, timeZone }) {
  const school = schoolName || 'Your school';
  const child = listNames(childNames || []);
  const until = formatDate(expiresAt, timeZone);
  const install = [];
  if (links?.android) install.push(`Android: ${links.android}`);
  if (links?.ios) install.push(`iPhone: ${links.ios}`);
  const installLine = install.length
    ? `1. Install the Voltava parent app.\n   ${install.join('\n   ')}`
    : '1. Install the Voltava parent app from the Play Store or App Store.';

  const text = [
    `Namaste${parentName ? ` ${parentName}` : ''},`,
    '',
    `${school} uses Voltava to show ${child}'s school bus live, and to tell you when they board and reach school.`,
    '',
    installLine,
    `2. Sign in with your email: ${email}`,
    `   One-time code: ${code}`,
    '3. Choose your own password.',
    '',
    `This code works for you only, and expires on ${until}. Do not share it with anyone.`,
    `If it has expired, ask the school's transport office for a new one.`,
    '',
    `${school} transport office`,
  ].join('\n');

  const linkHtml = install.length
    ? [links?.android && `<a href="${escapeHtml(links.android)}">Get it on Google Play</a>`, links?.ios && `<a href="${escapeHtml(links.ios)}">Get it on the App Store</a>`].filter(Boolean).join(' &nbsp;·&nbsp; ')
    : 'Find <b>Voltava</b> on the Play Store or App Store.';
  const html = `<div style="font-family:Arial,sans-serif;color:#2B2521;max-width:520px">
<p>Namaste${parentName ? ` ${escapeHtml(parentName)}` : ''},</p>
<p><b>${escapeHtml(school)}</b> uses Voltava to show ${escapeHtml(child)}'s school bus live, and to tell you when they board and reach school.</p>
<ol>
<li>Install the Voltava parent app. ${linkHtml}</li>
<li>Sign in with your email: <b>${escapeHtml(email)}</b></li>
<li>Enter this one-time code, then choose your own password:<br>
<span style="display:inline-block;margin-top:6px;padding:8px 14px;background:#EFEBF7;border-radius:8px;font:bold 20px monospace;letter-spacing:2px;color:#2E2548">${escapeHtml(code)}</span></li>
</ol>
<p style="color:#5F5750">This code works for you only, and expires on ${escapeHtml(until)}. Do not share it with anyone. If it has expired, ask the school's transport office for a new one.</p>
<p>${escapeHtml(school)} transport office</p>
</div>`;

  return { subject: `${school}: your Voltava parent app invite`, text, html };
}

module.exports = { CHANNELS, STAFF_CHANNELS, stageOf, canInvite, expiryFor, inviteMessage, formatDate };
