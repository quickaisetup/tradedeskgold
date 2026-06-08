// Server-side proxy for Anthropic calls.
// Your real API key lives ONLY in Vercel's environment variables (ANTHROPIC_API_KEY)
// — it is never sent to the browser, so traders using your shared link can't see it.
//
// Optional simple per-IP rate limit so a handful of shared users can't run up a huge bill.
// (In-memory — resets on cold start. Good enough for a small group of traders.)

const RATE_LIMIT = 40;           // max requests per IP
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // per 24h
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_WINDOW_MS; }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    res.status(429).json({ error: { message: 'Daily AI usage limit reached for this shared link. Try again tomorrow, or add your own Anthropic API key in Settings.' } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing ANTHROPIC_API_KEY env var.' } });
    return;
  }

  // Strip our internal field before forwarding to Anthropic
  const { _userKey, ...payload } = req.body || {};

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: 'Upstream request failed: ' + err.message } });
  }
}
