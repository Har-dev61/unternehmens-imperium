/**
 * Mail abstraction for account e-mails (verification + password reset).
 *
 * By design this currently only LOGS the message — no SMTP dependency is added
 * yet (per the project's "no external deps unless needed" stance). When you are
 * ready to send real mail, set the SMTP_* env vars and implement `deliver()`
 * below (e.g. with nodemailer: `npm i nodemailer` in /server, then create a
 * transport from the env and call transport.sendMail). Nothing else changes.
 *
 * Env vars:
 *   APP_BASE_URL          public site URL, used to build links (default '')
 *   MAIL_FROM             sender address shown in logs/mails
 *   SMTP_HOST/PORT/USER/PASS   wired into deliver() once you add a transport
 *   MAIL_DEV_RETURN_TOKENS=1   DEV ONLY: also return tokens in API responses so
 *                              you can test verify/reset without a mailbox
 */
const BASE_URL = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
const FROM = process.env.MAIL_FROM ?? 'no-reply@imperium.local';
const SMTP_CONFIGURED = !!process.env.SMTP_HOST;

/** True when tokens may be echoed back to the client (development convenience). */
export const DEV_RETURN_TOKENS = process.env.MAIL_DEV_RETURN_TOKENS === '1';

function link(path, token) {
  const base = BASE_URL || '<APP_BASE_URL not set>';
  return `${base}/?${path}=${token}`;
}

/**
 * Actually hand the message to a transport. Stub: logs only. Replace the body
 * with a real SMTP/HTTP-API call when SMTP_* is configured.
 */
async function deliver({ to, subject, text }) {
  if (SMTP_CONFIGURED) {
    // TODO: wire a real transport here (e.g. nodemailer). Intentionally not a
    // dependency yet. Until then we still log so nothing silently disappears.
    console.warn('[mailer] SMTP_HOST set but no transport wired yet — logging instead.');
  }
  console.info(`[mailer] → ${to} | from ${FROM}\n  ${subject}\n  ${text}`);
}

export async function sendVerification(to, token, { username } = {}) {
  await deliver({
    to,
    subject: 'Bestätige deine E-Mail – Unternehmens-Imperium',
    text: `Hallo ${username ?? ''}, bestätige deine E-Mail: ${link('verify', token)}`,
  });
}

export async function sendPasswordReset(to, token) {
  await deliver({
    to,
    subject: 'Passwort zurücksetzen – Unternehmens-Imperium',
    text: `Setze dein Passwort zurück (1 Stunde gültig): ${link('reset', token)}`,
  });
}
