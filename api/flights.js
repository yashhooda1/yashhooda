// /api/flights — free global live-flight feed.
//
// Source chain (Nov 2026 rework, after adsb.lol started refusing radii > 250 NM
// and capping each IP at 500 requests/day, which broke the old 19-region sweep):
//   1. OpenSky Network /states/all — ONE call returns every tracked aircraft
//      worldwide (~11k airborne). Anonymous: 400 credits/day per IP, 4 per
//      global call. Set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET (free account,
//      OAuth2 client credentials) for 4,000/day and a 5-minute refresh.
//   2. adsb.lol fallback — a few <=250 NM circles over the busiest airspace.
//   3. Last-known-good snapshot from Upstash Redis, flagged `stale`.
//
// The snapshot lives in Redis (UPSTASH_REDIS_REST_URL / _TOKEN, already set),
// so the whole site makes at most one upstream refresh per window no matter
// how many visitors there are. Response shape is unchanged for the map.
// Origin/destination are filled from adsb.lol's "routeset" (best-effort).

const UA_MOD = 'YashHoodaPortfolio/1.0';
const SNAP_KEY = 'flights:snapshot';    // last good payload, kept 24 h as a fallback
const LOCK_KEY = 'flights:refresh-lock'; // one refresher at a time across instances
const OS_ID = process.env.OPENSKY_CLIENT_ID;
const OS_SECRET = process.env.OPENSKY_CLIENT_SECRET;
// Refresh window: 5 min with an OpenSky account (4,000 credits/day), 15 min
// anonymous (400/day ÷ 4 per global call = 100 calls/day).
const REFRESH_SEC = OS_ID && OS_SECRET ? 300 : 900;

/* ---------------------------------------------------------------- redis */
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(command) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}
async function rGetJSON(key) {
  const v = await redis(['GET', key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

/* -------------------------------------------------------------- OpenSky */
let osToken = null, osTokenExp = 0;   // warm-instance cache; tokens last ~30 min
async function openskyToken() {
  if (!OS_ID || !OS_SECRET) return null;
  if (osToken && Date.now() < osTokenExp) return osToken;
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: OS_ID, client_secret: OS_SECRET }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`OpenSky token HTTP ${r.status}`);
  const j = await r.json();
  osToken = j.access_token;
  osTokenExp = Date.now() + Math.max(60, (j.expires_in || 1800) - 60) * 1000;
  return osToken;
}

// State vector: [icao24, callsign, origin_country, time_position, last_contact,
// lon, lat, baro_alt_m, on_ground, velocity_ms, true_track, vertical_rate_ms,
// sensors, geo_alt_m, squawk, spi, position_source]
function shapeOpenSky(states) {
  return states
    .filter(s => s[5] != null && s[6] != null && !s[8])
    .map(s => {
      const altM = s[13] ?? s[7];
      return {
        icao:          s[0] || null,
        callsign:      (s[1] || '').trim() || s[0] || null,
        airline:       null,
        origin:        null, origin_iata: null, origin_name: null,
        dest:          null, dest_iata:   null, dest_name:   null,
        lat:           +s[6],
        lon:           +s[5],
        altitude_ft:   altM != null ? Math.round(altM * 3.28084) : 0,
        speed_mph:     s[9] != null ? Math.round(s[9] * 2.23694) : 0,
        heading:       Math.round(s[10] || 0),
        vertical_fpm:  s[11] != null ? Math.round(s[11] * 196.85) : 0,
        aircraft_type: null,
        country:       s[2] || null,
        source:        'opensky',
      };
    })
    .filter(f => f.altitude_ft > 1000);
}

async function fetchOpenSky() {
  const headers = { 'User-Agent': UA_MOD, Accept: 'application/json' };
  const tok = await openskyToken().catch(e => { console.warn('[flights]', e.message); return null; });
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch('https://opensky-network.org/api/states/all', { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`OpenSky HTTP ${r.status} (credits left: ${r.headers.get('x-rate-limit-remaining') ?? '?'})`);
  const d = await r.json();
  const states = Array.isArray(d.states) ? d.states : [];
  if (!states.length) throw new Error('OpenSky returned no states');
  return { flights: shapeOpenSky(states), total: states.length, source: tok ? 'opensky' : 'opensky-anon' };
}

/* ------------------------------------------------- adsb.lol (fallback) */
// adsb.lol refuses radii over 250 NM (HTTP 403) and allows 500 requests/day
// per IP, so the fallback is a handful of circles over the busiest airspace.
const ADSB_MAX_NM = 250;
const ADSB_REGIONS = [
  { lat: 29.9, lon: -95.3 },  // Houston
  { lat: 40.7, lon: -74.0 },  // New York
  { lat: 41.9, lon: -87.9 },  // Chicago
  { lat: 33.9, lon: -118.4 }, // Los Angeles
  { lat: 51.5, lon: -0.5 },   // London
  { lat: 50.0, lon: 8.6 },    // Frankfurt
];

async function fetchAdsbLol(shape) {
  const seen = new Set(), all = [], errors = [];
  for (const { lat, lon } of ADSB_REGIONS) {
    try {
      const r = await fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${ADSB_MAX_NM}`, {
        headers: { 'User-Agent': UA_MOD, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { errors.push(`${r.status}`); if (r.status === 429) break; continue; }
      const d = await r.json();
      for (const ac of d.ac || []) if (ac.hex && !seen.has(ac.hex)) { seen.add(ac.hex); all.push(ac); }
    } catch (e) { errors.push(e.name); }
  }
  if (!all.length) throw new Error(`adsb.lol returned nothing (${errors.join(', ') || 'empty'})`);
  return { flights: shape(all), total: all.length, source: 'adsb-lol' };
}

/* ------------------------------------------- routes via adsbdb (fallback) */
// adsb.lol's routeset has been returning empty bodies (and its single-route
// endpoint 503 "no healthy upstream"), so flights still missing a route are
// looked up on adsbdb.com by callsign. Each answer — including "unknown" — is
// cached in Redis for a day, and at most ROUTE_LOOKUPS_PER_REFRESH new
// callsigns are fetched per refresh, so coverage fills in over a few refreshes.
const ROUTE_LOOKUPS_PER_REFRESH = 40;
const ROUTE_TTL = 86400;

async function redisPipeline(commands) {
  if (!R_URL || !R_TOK || !commands.length) return null;
  try {
    const r = await fetch(`${R_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(4000),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function applyRoute(f, rt) {
  if (!rt || !rt.o) return;
  f.origin = rt.o.city || rt.o.name || rt.o.iata; f.origin_iata = rt.o.iata || null; f.origin_name = rt.o.name || null;
  f.dest   = rt.d.city || rt.d.name || rt.d.iata; f.dest_iata   = rt.d.iata || null; f.dest_name   = rt.d.name || null;
  if (!f.airline && rt.airline) { f.airline = rt.airline; f.airline_iata = f.airline_iata || rt.airline_iata || null; }
}

async function lookupAdsbdb(cs) {
  const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, {
    headers: { 'User-Agent': UA_MOD, Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 404) return {};                 // unknown callsign: cache the miss
  if (!r.ok) throw new Error(`adsbdb HTTP ${r.status}`);
  const fr = ((await r.json()).response || {}).flightroute;
  if (!fr || !fr.origin || !fr.destination) return {};
  const ap = (a) => ({ iata: a.iata_code || a.icao_code || null, name: a.name || null, city: a.municipality || null });
  return { o: ap(fr.origin), d: ap(fr.destination), airline: (fr.airline || {}).name || null, airline_iata: (fr.airline || {}).iata || null };
}

async function enrichFromAdsbdb(flights) {
  const need = flights.filter(f => !f.origin_iata && !f.dest_iata && f.callsign && f.callsign !== f.icao && /^[A-Z]{3}\d/.test(f.callsign));
  if (!need.length) return;
  const keys = need.map(f => `flights:route:${f.callsign}`);
  const cached = R_URL ? await redis(['MGET', ...keys]) : null;
  const misses = [];
  need.forEach((f, i) => {
    const hit = Array.isArray(cached) ? cached[i] : null;
    if (hit) { try { applyRoute(f, JSON.parse(hit)); } catch { /* ignore bad cache */ } }
    else misses.push(f);
  });
  const batch = misses.slice(0, ROUTE_LOOKUPS_PER_REFRESH);
  const writes = [];
  for (let i = 0; i < batch.length; i += 5) {          // 5 at a time — be gentle with a free service
    await Promise.all(batch.slice(i, i + 5).map(async f => {
      try {
        const rt = await lookupAdsbdb(f.callsign);
        applyRoute(f, rt);
        writes.push(['SET', `flights:route:${f.callsign}`, JSON.stringify(rt), 'EX', String(ROUTE_TTL)]);
      } catch { /* transient: try again next refresh */ }
    }));
  }
  await redisPipeline(writes);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const UA = 'YashHoodaPortfolio/1.0';

  // Shape one adsb.lol aircraft record into the map's flight object.
  function shapeAdsb(aircraft) {
    return aircraft
      .filter(a => a.lat && a.lon && !a.gnd)
      .map(a => {
        const altGeom = a.alt_geom && a.alt_geom > 1000 ? a.alt_geom : null;
        const altBaro = a.alt_baro && a.alt_baro > 1000 ? a.alt_baro : null;
        const altitude_ft = altGeom || altBaro || 0;
        return {
          icao:          a.hex || null,
          callsign:      a.flight?.trim() || a.hex || null,
          airline:       null,              // frontend derives from callsign prefix
          origin:        null, origin_iata: null, origin_name: null,
          dest:          null, dest_iata:   null, dest_name:   null,
          lat:           parseFloat(a.lat),
          lon:           parseFloat(a.lon),
          altitude_ft,
          speed_mph:     a.gs ? Math.round(a.gs * 1.15078) : 0,   // gs is knots

          heading:       Math.round(a.track || 0),
          vertical_fpm:  a.baro_rate || 0,
          aircraft_type: a.t || null,
          source:        'adsb',
        };
      })
      .filter(f => f.altitude_ft > 1000); // drop ground/low readings
  }

  // Fill origin/destination via adsb.lol's ADSBExchange-compatible routeset API.
  // Best-effort: any failure leaves routes null and never breaks the map.
  async function enrichRoutes(flights) {
    const withCs = flights.filter(f => f.callsign && f.callsign !== f.icao);
    if (!withCs.length) return;
    const planes = withCs.map(f => ({ callsign: f.callsign.trim(), lat: f.lat, lng: f.lon }));

    let data;
    try {
      const r = await fetch('https://api.adsb.lol/api/0/routeset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ planes }),
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) return;
      data = await r.json();
    } catch (_) {
      return; // routes are a bonus, not a requirement
    }
    if (!Array.isArray(data)) return;

    const apply = (f, route) => {
      if (!route || route.plausible === false) return;
      const airports = Array.isArray(route._airports) ? route._airports : [];
      if (airports.length >= 2) {
        const o = airports[0], d = airports[airports.length - 1];
        f.origin      = o.location || o.name || o.iata || null;
        f.origin_iata = o.iata || null;
        f.origin_name = o.name || null;
        f.dest        = d.location || d.name || d.iata || null;
        f.dest_iata   = d.iata || null;
        f.dest_name   = d.name || null;
      } else if (typeof route.airport_codes === 'string' && route.airport_codes.includes('-')) {
        const [o, d] = route.airport_codes.split('-');
        f.origin = f.origin_iata = o || null;
        f.dest   = f.dest_iata   = d || null;
      }
    };

    // The routeset response mirrors the request order; fall back to callsign map.
    if (data.length === withCs.length) {
      withCs.forEach((f, i) => apply(f, data[i]));
    } else {
      const byCs = new Map();
      for (const route of data) {
        const cs = ((route && route.callsign) || '').trim();
        if (cs && !byCs.has(cs)) byCs.set(cs, route);
      }
      for (const f of withCs) apply(f, byCs.get(f.callsign.trim()));
    }
  }

  const send = (payload, extra = {}) => {
    // Short edge cache on top of the shared Redis snapshot.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ...payload, ...extra });
  };

  try {
    // 1. Serve the shared snapshot while it's fresh.
    const snap = await rGetJSON(SNAP_KEY);
    const ageSec = snap ? (Date.now() - snap.timestamp) / 1000 : Infinity;
    if (snap && ageSec < REFRESH_SEC) return send(snap, { age_sec: Math.round(ageSec) });

    // 2. One refresher at a time; everyone else gets the (slightly old) snapshot.
    const gotLock = R_URL ? (await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', '45'])) === 'OK' : true;
    if (!gotLock && snap) return send(snap, { age_sec: Math.round(ageSec) });

    // 3. Refresh: OpenSky, then adsb.lol.
    let got = null;
    const errors = [];
    for (const attempt of [fetchOpenSky, () => fetchAdsbLol(shapeAdsb)]) {
      try { got = await attempt(); if (got.flights.length) break; got = null; }
      catch (e) { errors.push(e.message); console.warn('[flights]', e.message); }
    }

    if (!got) {
      if (R_URL) await redis(['DEL', LOCK_KEY]);
      // 4. Both sources down: last good snapshot beats an empty map.
      if (snap) return send(snap, { stale: true, age_sec: Math.round(ageSec), upstream_errors: errors });
      return res.status(503).json({ error: 'Flight data source unavailable.', detail: errors, flights: [], total: 0 });
    }

    // Even global spread, then cap the number of markers the map draws.
    const shaped = got.flights;
    shaped.sort((a, b) => a.lon - b.lon);
    const MAX_MARKERS = 300;
    const step = Math.max(1, Math.floor(shaped.length / MAX_MARKERS));
    const flights = shaped.filter((_, i) => i % step === 0).slice(0, MAX_MARKERS);

    // Fill origin/destination for the markers we're actually showing:
    // adsb.lol routeset first, then adsbdb for whatever is still missing.
    await enrichRoutes(flights);
    await enrichFromAdsbdb(flights);

    const payload = { flights, total: got.total, shown: flights.length, source: got.source, timestamp: Date.now() };
    if (R_URL) {
      await redis(['SET', SNAP_KEY, JSON.stringify(payload), 'EX', '86400']);
      await redis(['DEL', LOCK_KEY]);
    }
    return send(payload, { age_sec: 0 });
  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error', flights: [], total: 0 });
  }
}
