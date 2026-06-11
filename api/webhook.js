const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

/* ── SHA-256 helpers for Meta CAPI PII hashing ── */
function sha256(str) {
  return crypto.createHash('sha256').update((str || '').trim().toLowerCase()).digest('hex');
}
function hashPhone(raw) {
  // keep digits only, no country prefix normalisation needed (already sent as +34...)
  return sha256(raw.replace(/\D/g, ''));
}
function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  return { fn: parts[0] || '', ln: parts.slice(1).join(' ') || '' };
}

/* ── Meta Conversions API Purchase event ── */
async function sendMetaPurchase(pi) {
  const token = process.env.FB_ACCESS_TOKEN;
  const pixelId = '1535416804668044';
  if (!token) return;

  const shipping = pi.shipping || {};
  const addr = shipping.address || {};
  const { fn, ln } = splitName(shipping.name);

  const userData = {};
  if (pi.receipt_email)      userData.em  = [sha256(pi.receipt_email)];
  if (shipping.phone)        userData.ph  = [hashPhone(shipping.phone)];
  if (fn)                    userData.fn  = [sha256(fn)];
  if (ln)                    userData.ln  = [sha256(ln)];
  if (addr.city)             userData.ct  = [sha256(addr.city)];
  if (addr.postal_code)      userData.zp  = [sha256(addr.postal_code)];
  if (addr.country)          userData.country = [sha256(addr.country.toLowerCase())];
  userData.client_user_agent = '';

  const packNum = parseInt((pi.metadata || {}).pack, 10) || 2;
  const packQty = { 1: 1, 2: 2, 3: 3 };

  const payload = {
    data: [{
      event_name:    'Purchase',
      event_time:    Math.floor(Date.now() / 1000),
      event_id:      pi.id,          // matches client-side eventID → deduplication
      action_source: 'website',
      event_source_url: 'https://ventilador-funnel.vercel.app',
      user_data:     userData,
      custom_data: {
        currency:     'EUR',
        value:        (pi.amount / 100).toFixed(2),
        content_ids:  ['ventilador-techo-led-60w'],
        content_type: 'product',
        content_name: 'Ventilador de Techo Silencioso LED 60W',
        num_items:    packQty[packNum] || 1,
        order_id:     pi.id
      }
    }]
  };

  // Include test event code only when env var is set (remove after live validation)
  if (process.env.FB_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.FB_TEST_EVENT_CODE;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const json = await res.json();
    if (!res.ok) console.error('Meta CAPI error:', JSON.stringify(json));
    else console.log('Meta CAPI Purchase sent:', json.events_received);
  } catch (err) {
    console.error('Meta CAPI fetch error:', err.message);
  }
}

/* ── TikTok Events API PlaceAnOrder event ── */
async function sendTikTokPurchase(pi) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const pixelId = 'D8GAHK3C77UFK9KDV3O0';
  if (!token) return;

  const shipping = pi.shipping || {};
  const addr = shipping.address || {};
  const { fn, ln } = splitName(shipping.name);
  const packNum = parseInt((pi.metadata || {}).pack, 10) || 2;
  const packQty = { 1: 1, 2: 2, 3: 3 };
  const qty = packQty[packNum] || 1;
  const value = (pi.amount / 100);

  const ttclid = (pi.metadata || {}).ttclid;
  const user = {};
  if (pi.receipt_email)  user.email        = sha256(pi.receipt_email);
  if (shipping.phone)    user.phone_number  = sha256(shipping.phone.replace(/\D/g,''));
  if (fn)                user.first_name    = sha256(fn);
  if (ln)                user.last_name     = sha256(ln);
  if (addr.city)         user.city          = sha256(addr.city.toLowerCase());
  if (addr.postal_code)  user.zip_code      = sha256(addr.postal_code);
  if (addr.country)      user.country       = sha256(addr.country.toLowerCase());
  if (ttclid)            user.ttclid        = ttclid;

  const payload = {
    pixel_code:       pixelId,
    event_source:     'web',
    event_source_id:  pixelId,
    data: [{
      event:      'PlaceAnOrder',
      event_time: Math.floor(Date.now() / 1000),
      event_id:   pi.id,
      user,
      properties: {
        currency: 'EUR',
        value,
        contents: [{
          content_id:   'ventilador-techo-led-60w',
          content_type: 'product',
          content_name: 'Ventilador de Techo LED 60W',
          price:        value,
          quantity:     qty
        }]
      },
      page: { url: 'https://www.shopiluminaes.online' }
    }]
  };

  try {
    const res = await fetch(
      'https://business-api.tiktok.com/open_api/v1.3/event/track/',
      { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const json = await res.json();
    if (!res.ok) console.error('TikTok Events API error:', JSON.stringify(json));
    else console.log('TikTok Events API PlaceAnOrder sent:', json.message);
  } catch (err) {
    console.error('TikTok Events API fetch error:', err.message);
  }
}

/* ── Main webhook handler ── */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const sig    = req.headers['stripe-signature'];
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    console.log(`PaymentIntent succeeded: ${pi.id}`);

    // Update Supabase order status
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { error } = await supabase
        .from('ventilador_orders')
        .update({ status: 'paid', customer_email: pi.receipt_email || null, shipping_address: pi.shipping || null })
        .eq('payment_intent_id', pi.id);
      if (error) console.error('Supabase update error:', error.message);
    }

    // Meta Conversions API — server-side Purchase (deduplicated via event_id = pi.id)
    await sendMetaPurchase(pi);
    // TikTok Events API — server-side PlaceAnOrder (deduplicated via event_id = pi.id)
    await sendTikTokPurchase(pi);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    console.log(`PaymentIntent failed: ${pi.id}`);
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await supabase.from('ventilador_orders').update({ status: 'failed' }).eq('payment_intent_id', pi.id);
    }
  }

  return res.status(200).json({ received: true });
};
