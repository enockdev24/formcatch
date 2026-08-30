/**
 * api/submit.js — Vercel serverless function.
 * Free hosts (Vercel, Netlify) run this on-demand per request — you never
 * start, stop, or monitor a server. This replaces server.js from the
 * earlier version.
 *
 * Where your form's real destination goes:
 *   Search for "FORWARD_TO_EMAIL" below and follow the comment — that's
 *   the one line you may want a helper to change later. Everything else
 *   works as-is.
 */

const MIN_SUBMIT_MS = 400;
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

// NOTE: serverless functions don't keep memory between requests reliably,
// so this in-memory limiter is best-effort, not exact. Fine for launch;
// swap for Vercel KV (also free tier) later if spam volume gets serious.
const submissionLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  submissionLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function checkSubmission(body, ip) {
  if (body.formcatch_hp && body.formcatch_hp.trim() !== '') {
    return { pass: false, reason: 'honeypot triggered' };
  }

  const loadedAt = parseInt(body.formcatch_ts, 10);
  if (!loadedAt || isNaN(loadedAt)) {
    return { pass: false, reason: 'missing timing token' };
  }
  const elapsed = Date.now() - loadedAt;
  if (elapsed < MIN_SUBMIT_MS) {
    return { pass: false, reason: `timing anomaly (${elapsed}ms)` };
  }

  if (isRateLimited(ip)) {
    return { pass: false, reason: 'rate limited' };
  }

  return { pass: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const body = req.body || {};
  const result = checkSubmission(body, ip);

  if (!result.pass) {
    console.log(`[formcatch] CAUGHT — ${result.reason} — ip=${ip}`);
    // Return 200 so the bot doesn't learn it was caught. Nothing forwards.
    return res.status(200).json({ ok: true });
  }

  console.log(`[formcatch] PASS — ip=${ip} — name=${body.name || 'n/a'}`);

  // ---- FORWARD_TO_EMAIL ----
  // Right now, a passed submission is only logged, not delivered anywhere.
  // To actually receive messages, the simplest free option with no code
  // is to point your <form action="..."> at a service like Formspree's
  // free tier AFTER Formcatch passes it — see the deploy guide, step 5.
  // --------------------------

  return res.status(200).json({ ok: true });
}
