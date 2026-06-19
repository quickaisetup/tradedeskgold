// Creates a Stripe Checkout session for a new subscription.
// Env vars needed in Vercel:
//   STRIPE_SECRET_KEY    — sk_live_... or sk_test_...
//   STRIPE_PRICE_ID      — price_... (your monthly subscription price)
//   SUPABASE_URL         — https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY — service_role key (not the anon key)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify the Supabase JWT from the Authorization header — proves the caller is
  // actually the logged-in user, not someone guessing a userId from outside.
  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // getUser() validates the JWT against Supabase — fake tokens are rejected
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  try {
    const { data: profile } = await sb
      .from('profiles').select('stripe_customer_id').eq('id', user.id).single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const origin = req.headers.origin || 'https://tradedeskgold.vercel.app';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/?subscribed=1`,
      cancel_url:  `${origin}/?canceled=1`,
      allow_promotion_codes: true,
      subscription_data: { metadata: { supabase_user_id: user.id } },
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[create-checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
};
