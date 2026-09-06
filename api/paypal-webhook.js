/**
 * api/paypal-webhook.js
 *
 * PayPal calls this URL directly (server to server) whenever something
 * happens to a subscription — activated, cancelled, payment failed, etc.
 * This is the SOURCE OF TRUTH for billing. The browser-side subscribe
 * button (in dashboard.html) only starts the process; this function is
 * what's actually allowed to change a site's plan in the database.
 *
 * Why verify the signature: without it, anyone could POST a fake
 * "subscription activated" message straight to this URL and get a free
 * upgrade. PayPal signs every real webhook; we check that signature
 * against PayPal's own servers before trusting anything in the body.
 *
 * SANDBOX FIRST: this points at PayPal's sandbox API by default. Do not
 * switch PAYPAL_API_BASE to the live URL until a full test subscription
 * has been created, activated, and cancelled successfully in sandbox.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;

// SANDBOX by default. Change to 'https://api-m.paypal.com' only after
// a full sandbox test cycle has worked.
const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';

// Maps YOUR PayPal subscription Plan IDs to your own plan names.
// Fill these in once you've created the plans (see setup steps).
const PLAN_ID_MAP = {
  'P-2NN27153MY454512FNKO3EOY': 'starter',
  'P-6MX56798ET963304BNKO3MIA': 'team',
  'P-4RU51372HT4295802NKO3NAQ': 'agency',
};

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

async function verifyWebhookSignature(headers, body, accessToken) {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transmission_id: headers['paypal-transmission-id'],
      transmission_time: headers['paypal-transmission-time'],
      cert_url: headers['paypal-cert-url'],
      auth_algo: headers['paypal-auth-algo'],
      transmission_sig: headers['paypal-transmission-sig'],
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: body,
    }),
  });
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body;

  let accessToken;
  try {
    accessToken = await getPayPalAccessToken();
  } catch (e) {
    console.error('[paypal-webhook] failed to get access token:', e.message);
    return res.status(500).json({ error: 'internal' });
  }

  const isValid = await verifyWebhookSignature(req.headers, event, accessToken);
  if (!isValid) {
    console.error('[paypal-webhook] signature verification FAILED — ignoring event, possible spoof attempt');
    return res.status(400).json({ error: 'invalid signature' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const eventType = event.event_type;
  const resource = event.resource;

  console.log('[paypal-webhook] verified event:', eventType);

  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
    const siteId = resource.custom_id;
    const planId = resource.plan_id;
    const ourPlanName = PLAN_ID_MAP[planId];

    if (!siteId || !ourPlanName) {
      console.error('[paypal-webhook] activated event missing site_id or unknown plan_id:', siteId, planId);
      return res.status(200).json({ ok: true }); // acknowledge so PayPal stops retrying, but nothing changes
    }

    const { error } = await admin
      .from('sites')
      .update({ plan: ourPlanName })
      .eq('id', siteId);

    if (error) {
      console.error('[paypal-webhook] failed to update plan:', error.message);
    } else {
      console.log(`[paypal-webhook] site ${siteId} upgraded to ${ourPlanName}`);
    }
  }

  if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.EXPIRED') {
    const siteId = resource.custom_id;
    if (siteId) {
      await admin.from('sites').update({ plan: 'free' }).eq('id', siteId);
      console.log(`[paypal-webhook] site ${siteId} downgraded to free (${eventType})`);
    }
  }

  // Always acknowledge receipt, even for event types we don't act on —
  // PayPal will keep retrying an endpoint that doesn't return 200.
  return res.status(200).json({ ok: true });
}
