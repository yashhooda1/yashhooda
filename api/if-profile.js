// api/if-profile.js
// ──────────────────────────────────────────────────────────────────────────────
// Live Infinite Flight profile stats for Yash_Hooda via the IF Live API v2.
// Endpoint: POST https://api.infiniteflight.com/public/v2/users
// Set INFINITE_FLIGHT_API_KEY in Vercel → Settings → Environment Variables.
// ──────────────────────────────────────────────────────────────────────────────

const IF_USERS_ENDPOINT = 'https://api.infiniteflight.com/public/v2/users';
const IF_USERNAME = 'Yash_Hooda';

// IF ATC rank codes → labels
const ATC_RANKS = [
  'Observer', 'ATC Trainee', 'ATC Apprentice', 'ATC Specialist',
  'ATC Officer', 'ATC Supervisor', 'ATC Recruiter', 'ATC Manager',
];

// Last-known-good fallback so the card always renders, even if the API is down
// or the key is missing. Update occasionally; the live values override it.
const SEED = {
  username: 'Yash_Hooda',
  grade: 3,
  xp: 859750,
  onlineFlights: 653,
  landingCount: 242,
  flightTimeMinutes: 82038,
  flightTimeHours: 1367,
  flightTimeLabel: '1,367h 18m',
  atcOperations: 107,
  atcRank: 'Observer',
  violations: 28,
  stale: true,
};

function shape(u) {
  const mins = Number(u.flightTime) || 0;
  const rank = (typeof u.atcRank === 'number' && ATC_RANKS[u.atcRank]) ? ATC_RANKS[u.atcRank] : null;
  return {
    username: u.discourseUsername || IF_USERNAME,
    grade: u.grade ?? null,
    xp: u.xp ?? null,
    onlineFlights: u.onlineFlights ?? null,
    landingCount: u.landingCount ?? null,
    flightTimeMinutes: mins,
    flightTimeHours: Math.floor(mins / 60),
    flightTimeLabel: `${Math.floor(mins / 60).toLocaleString()}h ${mins % 60}m`,
    atcOperations: u.atcOperations ?? null,
    atcRank: rank,
    violations: u.violations ?? null,
    stale: false,
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.INFINITE_FLIGHT_API_KEY;

  // Cache at the edge for ~1h so we never hammer the IF API (respects their
  // polling best practices); serve stale for a day while revalidating.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  if (!apiKey) {
    return res.status(200).json({ ...SEED, error: 'IF API key not configured' });
  }

  try {
    const r = await fetch(IF_USERS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ discourseNames: [IF_USERNAME] }),
    });

    if (!r.ok) {
      return res.status(200).json({ ...SEED, error: `IF API responded ${r.status}` });
    }

    const data = await r.json();
    // v2 shape: { errorCode: 0, result: [ { ...userStats } ] }
    const user = Array.isArray(data?.result) ? data.result[0] : null;
    if (!user) {
      return res.status(200).json({ ...SEED, error: 'user not found in IF response' });
    }

    return res.status(200).json(shape(user));
  } catch (err) {
    return res.status(200).json({ ...SEED, error: String(err?.message || err) });
  }
}
