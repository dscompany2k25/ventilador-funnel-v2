const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const PACK_AMOUNTS = { 1: 2900, 2: 4900, 3: 6400 };
const PACK_NAMES   = { 1: '1 Unidad', 2: '2 Unidades', 3: '3 Unidades' };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe no configurado' });

  const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });

  try {
    // Support both pre-parsed body and stream body
    let body = req.body;
    if (!body || typeof body !== 'object') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }

    const packNum = parseInt(body.pack, 10);
    const color   = body.color || 'Blanco';
    const ttclid  = body.ttclid || '';

    if (!PACK_AMOUNTS[packNum]) {
      return res.status(400).json({ error: 'Pack inválido' });
    }

    const meta = {
      pack: packNum.toString(),
      pack_name: PACK_NAMES[packNum],
      color,
      product: 'Ventilador de Techo Silencioso LED 60W y Aspas Plegables'
    };
    if (ttclid) meta.ttclid = ttclid;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: PACK_AMOUNTS[packNum],
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: meta
    });

    // Set description using the actual PI ID so each order has a unique traceable code
    const piRef = paymentIntent.id.replace('pi_', '');
    await stripe.paymentIntents.update(paymentIntent.id, {
      description: `piV · ${piRef}`
    });

    // Log pending order to Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );
      const { error } = await supabase.from('ventilador_orders').insert({
        payment_intent_id: paymentIntent.id,
        pack: packNum,
        pack_name: PACK_NAMES[packNum],
        color,
        amount: PACK_AMOUNTS[packNum],
        currency: 'eur',
        status: 'pending'
      });
      if (error) console.error('Supabase insert error:', error.message);
    }

    return res.status(200).json({ client_secret: paymentIntent.client_secret });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
};
