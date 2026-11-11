// ══════════════════════════════════════════════════════
// AGENT FAILURE NOTIFIER
// Sends email via Resend + push via ntfy.sh
// Called from any API route on catch(err)
// ══════════════════════════════════════════════════════

export async function notifyFailure({ route, model, error, userMessage, sessionId }) {
  const ts        = new Date().toISOString();
  const subject   = `[ALERT] yashhooda1.vercel.app — ${route} failed`;
  const shortErr  = String(error?.message || error || 'Unknown error').slice(0, 300);
  const shortMsg  = String(userMessage || '').slice(0, 200);
  const body      = [
    `Route:      ${route}`,
    `Model:      ${model || 'N/A'}`,
    `Error:      ${shortErr}`,
    `Message:    ${shortMsg || '(none)'}`,
    `Session:    ${sessionId || 'anonymous'}`,
    `Timestamp:  ${ts}`,
    ``,
    `Check Vercel logs: https://vercel.com/dashboard`,
  ].join('\n');

  // ── Fire both in parallel, never throw ──
  await Promise.allSettled([
    sendEmail(subject, body),
    sendPush(subject, body),
  ]);
}

async function sendEmail(subject, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        // Nov 2026: was 'alerts@yashhooda1.vercel.app' — a vercel.app address can't be a verified
        // Resend sender. Use the yashhooda.ai domain the signup/reset emails already send from.
        from:    process.env.ALERT_FROM || 'HoodaAgents Alerts <noreply@yashhooda.ai>',
        to:      'yash.hooda6@gmail.com',
        subject,
        text:    body,
      }),
    });
    // A rejected send (bad sender, bad key) used to pass silently — surface it in Vercel logs.
    if (!r.ok) console.error('[NOTIFY] Email rejected:', r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.error('[NOTIFY] Email failed:', e.message);
  }
}

async function sendPush(subject, body) {
  const topic = process.env.NTFY_TOPIC || 'yash-agent-alerts';
  try {
    // Strip non-ASCII chars from headers — ntfy requires ByteString (0-255 only)
    const safeSubject = subject.replace(/[^\x00-\xFF]/g, '?');
    await fetch(`https://ntfy.sh/${topic}`, {
      method:  'POST',
      headers: {
        'Title':    safeSubject,
        'Priority': 'high',
        'Tags':     'warning,robot',
      },
      body: body.replace(/[^\x00-\xFF]/g, '?'),
    });
  } catch (e) {
    console.error('[NOTIFY] Push failed:', e.message);
  }
}
