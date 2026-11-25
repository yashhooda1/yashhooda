import { Redis } from '@upstash/redis';
import { getWeatherForActivity, heatIndexF, dewpointImpact, describeWeatherCode, compassFromDeg } from './lib/weatherEnrichment.js';

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


// Fetch every photo attached to an activity.
// `photo_sources=true` is mandatory — without it Strava only returns legacy
// Instagram photos (i.e. an empty array). `size` must be set or you get
// low-res placeholders back.
// Cached hard in Redis: photos on a finished activity never change, so this is
// a one-time API cost per activity rather than a per-request one.
async function photosCached(activityId, accessToken) {
  const key = `strava:photos:${activityId}`;

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null && hit !== undefined) return hit;
    } catch { /* fall through to fetch */ }
  }

  let photos = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/photos?photo_sources=true&size=1200`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(4000) }
    );

    if (r.status === 429) {
      // Rate limited — return empty but DON'T cache, so we retry next sync.
      console.warn('Strava photos 429; usage:', r.headers.get('X-RateLimit-Usage'));
      return [];
    }

    if (r.ok) {
      const raw = await r.json();
      photos = (Array.isArray(raw) ? raw : [])
        .map(p => {
          const url = p.urls ? Object.values(p.urls)[0] : null;
          const dim = p.sizes ? Object.values(p.sizes)[0] : null;
          if (!url) return null;
          return {
            url,
            w: Array.isArray(dim) ? dim[0] : null,
            h: Array.isArray(dim) ? dim[1] : null,
            caption: p.caption || '',
          };
        })
        .filter(Boolean);
    }
  } catch { /* leave empty */ }

  if (redis) { try { await redis.set(key, photos, { ex: 60 * 60 * 24 * 7 }); } catch {} }
  return photos;
}


// Weather at the activity — Open-Meteo hourly, keyed on start lat/lon and the
// activity's MIDPOINT in real UTC (a.start_date, not start_date_local).
// Indoor / no-GPS activities get null. Shaped like Strava's own weather line:
// "Clear, 39 °F. Feels like 33 °F. Humidity 82%. Wind 6.5 mi/h from NNW."
const WX_KEY = (id) => `strava:wx:v1:${id}`;
const WX_MAX_FETCH_PER_REQUEST = 15;   // cold-cache backfill cap; fills in over a few loads

async function fetchActivityWeather(a) {
  if (!Array.isArray(a.start_latlng) || a.start_latlng.length < 2 || !a.start_date) return null;
  const start = new Date(a.start_date).getTime();
  if (Number.isNaN(start)) return null;
  // Midpoint of the activity, +30 min so the helper's hour-floor lands on the NEAREST hour.
  const mid = start + ((a.elapsed_time || a.moving_time || 0) * 1000) / 2 + 30 * 60 * 1000;
  const wx = await getWeatherForActivity({
    lat: a.start_latlng[0], lon: a.start_latlng[1], isoTimeGMT: new Date(mid).toISOString(),
  });
  if (!wx || wx.tempF == null) return null;
  const cond = describeWeatherCode(wx.weatherCode, wx.isDay);
  const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    condition:    cond?.label || null,
    icon:         cond?.icon || null,
    temp_f:       Math.round(wx.tempF),
    feels_like_f: wx.apparentF != null ? Math.round(wx.apparentF) : null,
    humidity_pct: wx.humidityPct != null ? Math.round(wx.humidityPct) : null,
    dewpoint_f:   wx.dewpointF != null ? Math.round(wx.dewpointF) : null,
    wind_mph:     r1(wx.windMph),
    wind_dir:     compassFromDeg(wx.windDirDeg),
    heat_index_f: heatIndexF(wx.tempF, wx.humidityPct),
    heat_stress:  dewpointImpact(wx.tempF, wx.dewpointF),   // { sum, zone, paceImpact }
    source:       'open-meteo',
  };
}

async function weatherForActivities(activities) {
  const out = {};
  const outdoor = activities.filter(a => Array.isArray(a.start_latlng) && a.start_latlng.length >= 2);
  if (!outdoor.length) return out;

  if (redis) {
    try {
      const hits = await redis.mget(...outdoor.map(a => WX_KEY(a.id)));
      outdoor.forEach((a, i) => { if (hits[i]) out[a.id] = hits[i]; });
    } catch { /* fall through to fetch */ }
  }

  const misses = outdoor.filter(a => !(a.id in out)).slice(0, WX_MAX_FETCH_PER_REQUEST);
  await Promise.all(misses.map(async (a) => {
    const wx = await fetchActivityWeather(a);
    if (!wx) return;                       // don't cache failures — retry next load
    out[a.id] = wx;
    if (redis) {
      // Very recent activities get a short TTL so modeled hours settle to observed data.
      const ageH = (Date.now() - new Date(a.start_date).getTime()) / 3.6e6;
      const ex = ageH < 48 ? 60 * 60 * 6 : 60 * 60 * 24 * 180;
      try { await redis.set(WX_KEY(a.id), wx, { ex }); } catch {}
    }
  }));
  return out;
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
       'https://www.strava.com/api/v3/athlete/activities?per_page=50&page=1',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const activities = await actRes.json();
    if (!actRes.ok) {
      return res.status(502).json({ error: 'Activities fetch failed', detail: activities });
    }

    // 3a. Fetch descriptions with timeout to avoid blocking mobile.
    //     Now Redis-cached (6h) — this endpoint was previously hit on every
    //     cold request, which alone was pushing the daily read limit.
    //     The same detail call carries device_name ("Apple Watch Ultra 4"), which
    //     never changes for a finished activity, so it's cached for 90 days.
    const descriptions = {};
    const devices = {};
    const DEVICE_TTL = 60 * 60 * 24 * 90;
    if (redis && activities.length) {
        try {
            const hits = await redis.mget(...activities.map(a => `strava:device:${a.id}`));
            activities.forEach((a, i) => { if (hits[i] !== null && hits[i] !== undefined) devices[a.id] = hits[i] || null; });
        } catch {}
    }
    const descTimeout = (id, needDesc = true) => new Promise(async resolve => {
        const dkey = `strava:desc:${id}`;
        if (redis && needDesc) {
            try {
                const hit = await redis.get(dkey);
                if (hit !== null && hit !== undefined) {
                    descriptions[id] = hit || null;
                    if (id in devices) return resolve();
                }
            } catch {}
        }
        if (!needDesc && id in devices) return resolve();
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); resolve(); }, 3000);
        fetch(`https://www.strava.com/api/v3/activities/${id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal
        })
        .then(r => r.json())
        .then(async d => {
            if (!d || !d.id) return;  // error payload (e.g. 429): cache nothing
            if (needDesc) descriptions[id] = d.description || null;
            devices[id] = d.device_name || null;
            if (redis) {
                if (needDesc) { try { await redis.set(dkey, d.description || '', { ex: 60 * 60 * 6 }); } catch {} }
                try { await redis.set(`strava:device:${id}`, d.device_name || '', { ex: DEVICE_TTL }); } catch {}
            }
        })
        .catch(() => {})
        .finally(() => { clearTimeout(timer); resolve(); });
    });
    // Newest 6 get description + device; then backfill the device for up to 8
    // older activities per request, so the feed fills in without a fan-out.
    const backfill = activities.slice(6).filter(a => !(a.id in devices)).slice(0, 8);
    await Promise.all([
        ...activities.slice(0, 6).map(a => descTimeout(a.id)),
        ...backfill.map(a => descTimeout(a.id, false)),
    ]);

    // 3a-ii. Photos — only for activities that actually have them (the summary
    //        payload tells us via total_photo_count, so we skip the empty ones
    //        for free), capped at the 12 most recent so a backfill can never
    //        fan out into a rate-limit wipeout.
    const photoTargets = activities
      .filter(a => (a.total_photo_count || 0) > 0)
      .slice(0, 12);

    const photosById = {};
    await Promise.all(photoTargets.map(async (a) => {
      photosById[a.id] = await photosCached(a.id, accessToken);
    }));

    // Dedupe coordinates within this request → one geocode per unique spot, not per activity.
    const coordKey = (a) =>
      (Array.isArray(a.start_latlng) && a.start_latlng.length >= 2)
        ? `${a.start_latlng[0].toFixed(3)},${a.start_latlng[1].toFixed(3)}`
        : null;

    const uniqueKeys = [...new Set(activities.map(coordKey).filter(Boolean))];
    const labelByKey = {};
    let weatherById = {};
    await Promise.all([
      ...uniqueKeys.map(async (k) => {
        const [lat, lon] = k.split(',').map(Number);
        labelByKey[k] = await geocodeCached(lat, lon);
      }),
      weatherForActivities(activities).then(w => { weatherById = w; }).catch(() => {}),
    ]);

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
      device_name:   devices[a.id] || null,
      kudos:         a.kudos_count,
      suffer_score:  a.suffer_score || null,
      map_polyline:  a.map?.summary_polyline || null,
      photos:        photosById[a.id] || [],
      photo_count:   a.total_photo_count || 0,
      weather:       weatherById[a.id] || null,
    }));

    // ── WEEKLY MILEAGE (Mon 00:00 → Sun 23:59:59.999, America/Chicago) ──
    // Both sides are held in "wall clock as UTC" form: start_date_local is local
    // wall time with a bogus Z, so we build `nowWall` the same way. Comparing
    // those directly is what stops the week rolling over at 7pm Sunday.
    const chi = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});

    const nowWall = new Date(
      `${chi.year}-${chi.month}-${chi.day}T${chi.hour}:${chi.minute}:${chi.second}Z`
    );

    const dow = nowWall.getUTCDay();                    // 0=Sun … 6=Sat
    const daysFromMonday = dow === 0 ? 6 : dow - 1;
    const monday = new Date(nowWall);
    monday.setUTCDate(nowWall.getUTCDate() - daysFromMonday);
    monday.setUTCHours(0, 0, 0, 0);

    const prevMonday = new Date(monday);
    prevMonday.setUTCDate(monday.getUTCDate() - 7);

    const wallDate = (s) => new Date(/[Zz]$/.test(s) ? s : `${s}Z`);

    const runMilesBetween = (from, toExclusive) => {
      const meters = activities
        .filter(a => {
          if (a.type !== 'Run') return false;
          const d = wallDate(a.start_date_local);
          return d >= from && d < toExclusive;
        })
        .reduce((sum, a) => sum + (a.distance || 0), 0);
      return parseFloat((meters / 1609.34).toFixed(1));
    };

    const weekly_miles    = runMilesBetween(monday, new Date(monday.getTime() + 7 * 864e5));
    const lastWeekMiles   = runMilesBetween(prevMonday, monday);

    // If the fetch window doesn't reach back past last Monday, the last-week
    // number is an undercount — flag it so the client hides it rather than lies.
    const oldest = activities.length
      ? wallDate(activities[activities.length - 1].start_date_local)
      : null;
    const last_week_miles = (oldest && oldest < prevMonday) ? lastWeekMiles : null;

    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      activities: shaped,
      weekly_miles,
      last_week_miles,
      week_start: monday.toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error('Strava handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
