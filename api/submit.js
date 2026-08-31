/**
 * api/submit.js — multi-tenant version.
 *
 * Every submission now carries a real site_id (from the installed
 * script's data-site attribute). This function verifies that site
 * exists, checks its plan's monthly limit, runs the same three checks
 * as before, and logs the result to THAT site's own row — so each
 * customer only ever sees their own data (enforced both here and by
 * the database's row-level security policies).
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIN_SUBMIT_MS = 400;
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
const PLAN_LIMITS = { free: 200, starter: Infinity, team: Infinity, agency: Infinity };

const submissionLog = new Map(); // best-effort in-memory rate limiter, per warm instance

function isRateLimited(key) {
  const now = Date.now();
  const timestamps = (submissionLog.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  submissionLog.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function runChecks(body, ip, siteId) {
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
  if (isRateLimited(siteId + ':' + ip)) {
    return { pass: false, reason: 'rate limited' };
  }
  return { pass: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const siteId = body.formcatch_site;
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  if (!siteId) {
    // No site ID at all means the script isn't installed correctly —
    // fail closed (block) rather than silently letting everything through.
    return res.status(200).json({ ok: true });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: site, error: siteError } = await admin
    .from('sites')
    .select('*')
    .eq('id', siteId)
    .single();

  if (siteError || !site) {
    return res.status(200).json({ ok: true }); // unknown site — silently drop
  }

  // Monthly limit check + reset if we've rolled into a new month.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const siteMonth = new Date(site.month_reset_at).toISOString().slice(0, 7);
  let submissionsThisMonth = site.submissions_this_month;
  if (thisMonth !== siteMonth) {
    submissionsThisMonth = 0;
    await admin.from('sites').update({ submissions_this_month: 0, month_reset_at: new Date().toISOString().slice(0,10) }).eq('id', siteId);
  }

  const limit = PLAN_LIMITS[site.plan] ?? PLAN_LIMITS.free;
  if (submissionsThisMonth >= limit) {
    await admin.from('submissions').insert({ site_id: siteId, status: 'catch', reason: 'monthly limit reached' });
    return res.status(200).json({ ok: true });
  }

  const result = runChecks(body, ip, siteId);

  await admin.from('submissions').insert({
    site_id: siteId,
    status: result.pass ? 'pass' : 'catch',
    reason: result.reason || null,
  });
  await admin
    .from('sites')
    .update({ submissions_this_month: submissionsThisMonth + 1 })
    .eq('id', siteId);

  if (!result.pass) {
    console.log(`[formcatch] CAUGHT — site=${siteId} — ${result.reason}`);
    return res.status(200).json({ ok: true });
  }

  console.log(`[formcatch] PASS — site=${siteId}`);
  // ... forward to the customer's real inbox/CRM here in a later phase ...

  return res.status(200).json({ ok: true });
}
