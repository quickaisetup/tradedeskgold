// Creates a Stripe Checkout session for a new subscription.
// Env vars needed in Vercel:
//   STRIPE_SECRET_KEY   — sk_live_... or sk_test_...
//   STRIPE_PRICE_ID     — price_... (your monthly subscription price)
//   SUPABASE_URL        — https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY — service_role key (not the anon key)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, email } = req.body || {};
  if (!userId || !email) return res.status(400).json({ error: 'Missing userId or email' });

  try {
    // Look up or create Stripe customer so we can link to the Supabase user
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: profile } = await sb
      .from('profiles').select('stripe_customer_id').eq('id', userId).single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId },
      });
      customerId = customer.id;
      await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
    }

    const origin = req.headers.origin || 'https://tradedeskgold.vercel.app';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/?subscribed=1`,
      cancel_url:  `${origin}/?canceled=1`,
      allow_promotion_codes: true,
      subscription_data: { metadata: { supabase_user_id: userId } },
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[create-checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
};
