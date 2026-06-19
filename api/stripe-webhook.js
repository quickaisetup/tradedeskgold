// Stripe webhook handler — keeps Supabase subscription_status in sync.
// Env vars needed in Vercel:
//   STRIPE_SECRET_KEY      sk_live_...
//   STRIPE_WEBHOOK_SECRET  whsec_... (from Stripe dashboard → Webhooks)
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Register this URL in Stripe dashboard:
//   https://tradedeskgold.vercel.app/api/stripe-webhook
// Events to enable:
//   checkout.session.completed
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Disable Vercel's body parser so we can verify the raw signature
module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function setStatus(userId, status) {
  if (!userId) return;
  await sb().from('profiles').update({ subscription_status: status }).eq('id', userId);
}

async function userIdFromCustomer(customerId) {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer?.metadata?.supabase_user_id || null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[webhook] signature failed:', e.message);
    return res.status(400).json({ error: `Webhook signature failed: ${e.message}` });
  }

  try {
    const obj = event.data.object;

    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'subscription') break;
        const userId = obj.subscription_data?.metadata?.supabase_user_id
          || await userIdFromCustomer(obj.customer);
        await setStatus(userId, 'active');
        break;
      }
      case 'customer.subscription.updated': {
        const userId = obj.metadata?.supabase_user_id
          || await userIdFromCustomer(obj.customer);
        const status = ['active', 'trialing'].includes(obj.status) ? 'active' : obj.status;
        await setStatus(userId, status);
        break;
      }
      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.supabase_user_id
          || await userIdFromCustomer(obj.customer);
        await setStatus(userId, 'canceled');
        break;
      }
      case 'invoice.payment_failed': {
        const userId = await userIdFromCustomer(obj.customer);
        await setStatus(userId, 'past_due');
        break;
      }
    }
  } catch (e) {
    console.error('[webhook] handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }

  res.status(200).json({ received: true });
};
