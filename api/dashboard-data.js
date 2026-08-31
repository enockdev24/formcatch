/**
 * api/dashboard-data.js
 *
 * Called by dashboard.html with the logged-in user's Supabase access
 * token. Verifies that token server-side (never trust a client-sent
 * user ID directly), finds or creates their site record, and returns
 * everything the dashboard needs in one response.
 *
 * Uses the SERVICE ROLE key — this must only ever run server-side.
 * Set it as an environment variable in Vercel; never put it in any
 * HTML/JS file the browser loads.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PLAN_LIMITS = {
  free: 200,
  starter: Infinity,
  team: Infinity,
  agency: Infinity,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Verify the token actually belongs to a real logged-in user.
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  const userId = userData.user.id;

  // Find their site, or create one on first visit.
  let { data: sites, error: siteError } = await admin
    .from('sites')
    .select('*')
    .eq('user_id', userId)
    .limit(1);

  if (siteError) {
    return res.status(500).json({ error: 'Database error' });
  }

  let site = sites?.[0];
  if (!site) {
    const { data: newSite, error: createError } = await admin
      .from('sites')
      .insert({ user_id: userId })
      .select()
      .single();
    if (createError) {
      return res.status(500).json({ error: 'Could not create site' });
    }
    site = newSite;
  }

  // Recent activity (last 10) and overall counts.
  const { data: recent } = await admin
    .from('submissions')
    .select('status, reason, created_at')
    .eq('site_id', site.id)
    .order('created_at', { ascending: false })
    .limit(10);

  const { count: passCount } = await admin
    .from('submissions')
    .select('*', { count: 'exact', head: true })
    .eq('site_id', site.id)
    .eq('status', 'pass');

  const { count: catchCount } = await admin
    .from('submissions')
    .select('*', { count: 'exact', head: true })
    .eq('site_id', site.id)
    .eq('status', 'catch');

  return res.status(200).json({
    site_id: site.id,
    plan: site.plan,
    limit: PLAN_LIMITS[site.plan],
    submissions_this_month: site.submissions_this_month,
    delivered_total: passCount || 0,
    blocked_total: catchCount || 0,
    recent: recent || [],
  });
}
