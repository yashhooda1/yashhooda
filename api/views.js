// Page view counter backed by Upstash Redis REST API.
// GET  -> read current count (no increment)
// POST -> increment, return new count

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'pageviews:yashhooda.ai';

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch|vercel-screenshot/i;

async function redis(...parts) {
  const res = await fetch(`${REDIS_URL}/${parts.join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const { result } = await res.json();
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'redis_not_configured' });
  }

  try {
    const ua = req.headers['user-agent'] || '';
    const isBot = BOT_RE.test(ua) || ua === '';

    let count;
    if (req.method === 'POST' && !isBot) {
      count = await redis('INCR', KEY);
    } else {
      count = await redis('GET', KEY);
    }

    return res.status(200).json({ count: Number(count) || 0 });
  } catch (err) {
    console.error('views error:', err);
    return res.status(500).json({ error: 'views_failed' });
  }
}
