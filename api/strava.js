import { Redis } from '@upstash/redis';

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

// Reverse-geocode "lat,lon" → "City, State" / "City, Country".
// Cached in Redis by rounded coords: a finished run's location never changes,
// and your runs cluster around a few spots, so this dedupes hard over time.
async function geocodeCached(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = `geo:${lat.toFixed(3)},${lon.toFixed(3)}`;   // ~110m buckets

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null && hit !== undefined) return hit || null; // '' = known-empty
    } catch { /* fall through to fetch */ }
  }

  let label = null;
  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (r.ok) {
      const d = await r.json();
      const city    = d.city || d.locality || null;
      const state   = d.principalSubdivision || null;
      const country = d.countryName || null;
      if (city && state && city !== state) label = `${city}, ${state}`;
      else if (city && country)            label = `${city}, ${country}`;
      else if (state && country)           label = `${state}, ${country}`;
      else                                 label = country || null;
    }
  } catch { /* leave null */ }

  if (redis) { try { await redis.set(key, label || '', { ex: 60 * 60 * 24 * 180 }); } catch {} }
  return label;
}


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const clientId     = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
  const fmtLocation = (a) => a.location_label || '';

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Strava env vars missing' });
  }

  try {
    // 1. Exchange refresh token for access token
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Token error:', tokenData);
      return res.status(502).json({ error: 'Token exchange failed', detail: tokenData });
    }
    const accessToken = tokenData.access_token;

    // 2. Fetch latest 8 activities
    const actRes = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const activities = await actRes.json();
    if (!actRes.ok) {
      return res.status(502).json({ error: 'Activities fetch failed', detail: activities });
    }

    // 3a. Fetch descriptions with timeout to avoid blocking mobile
    const descriptions = {};
    const descTimeout = (id) => new Promise(resolve => {
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); resolve(); }, 3000);
        fetch(`https://www.strava.com/api/v3/activities/${id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal
        })
        .then(r => r.json())
        .then(d => { descriptions[id] = d.description || null; })
        .catch(() => {})
        .finally(() => { clearTimeout(timer); resolve(); });
    });
    await Promise.all(activities.slice(0, 6).map(a => descTimeout(a.id)));

    // Dedupe coordinates within this request → one geocode per unique spot, not per activity.
    const coordKey = (a) =>
      (Array.isArray(a.start_latlng) && a.start_latlng.length >= 2)
        ? `${a.start_latlng[0].toFixed(3)},${a.start_latlng[1].toFixed(3)}`
        : null;

    const uniqueKeys = [...new Set(activities.map(coordKey).filter(Boolean))];
    const labelByKey = {};
    await Promise.all(uniqueKeys.map(async (k) => {
      const [lat, lon] = k.split(',').map(Number);
      labelByKey[k] = await geocodeCached(lat, lon);
    }));

    // 3. Shape the data
    const shaped = activities.map(a => ({
      id:            a.id,
      name:          a.name,
      type:          a.type,
      sport_type:    a.sport_type,
      date:          a.start_date_local,
      distance_m:    a.distance,
      distance_mi:   (a.distance / 1609.34).toFixed(2),
      moving_time_s: a.moving_time,
      elapsed_time_s:a.elapsed_time,
      elevation_m:   a.total_elevation_gain,
      elevation_ft:  (a.total_elevation_gain * 3.28084).toFixed(0),
      avg_speed_ms:  a.average_speed,
      location_label: labelByKey[coordKey(a)] || null,
      location_city:    a.location_city    || null,
      location_state:   a.location_state   || null,
      location_country: a.location_country || null,
      pace_min_mi:   a.average_speed > 0
        ? (() => {
            const secPerMi = 1609.34 / a.average_speed;
            const m = Math.floor(secPerMi / 60);
            const s = Math.round(secPerMi % 60);
            return s === 60 ? `${m + 1}:00` : `${m}:${s.toString().padStart(2, '0')}`;
          })()
        : null,
      avg_hr:        a.average_heartrate || null,
      max_hr:        a.max_heartrate || null,
      description:   descriptions[a.id] || null,
      kudos:         a.kudos_count,
      suffer_score:  a.suffer_score || null,
      map_polyline:  a.map?.summary_polyline || null,
    }));

    // Cache for 5 minutes
    // ── WEEKLY MILEAGE (Monday 00:00 → Sunday 23:59 current week) ──
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - daysFromMonday);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const weeklyMeters = activities
      .filter(a => {
        const d = new Date(a.start_date_local);
        return d >= monday && d <= sunday && a.type === 'Run';
      })
      .reduce((sum, a) => sum + (a.distance || 0), 0);

    const weekly_miles = parseFloat((weeklyMeters / 1609.34).toFixed(1));

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ activities: shaped, weekly_miles });
  } catch (err) {
    console.error('Strava handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
