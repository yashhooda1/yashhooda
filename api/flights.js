// /api/flights — free global live-flight feed from adsb.lol (community ADS-B).
// No API key, no per-call cost. Replaces the paid FlightAware AeroAPI path.
//
// Returns the same JSON shape the map already expects, so no frontend change
// is needed. Origin/destination are filled from adsb.lol's free "routeset"
// endpoint (best-effort — the map still renders if that lookup fails).

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
          speed_mph:     a.gs ? Math.round(a.gs) : 0,
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

  async function pool(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...await Promise.allSettled(items.slice(i, i + n).map(fn)));
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

  // Global sampling points (lat, lon, radius in nm). adsb.lol has worldwide
  // community coverage, strongest over Europe and North America.
  const regions = [
    // North America
    { lat: 45, lon: -115, dist: 800 }, { lat: 33, lon: -115, dist: 800 },
    { lat: 40, lon: -95,  dist: 800 }, { lat: 30, lon: -95,  dist: 800 },
    { lat: 43, lon: -73,  dist: 700 }, { lat: 32, lon: -83,  dist: 700 },
    // Europe
    { lat: 51, lon: 0,    dist: 700 }, { lat: 48, lon: 8,    dist: 700 },
    { lat: 41, lon: 15,   dist: 800 }, { lat: 52, lon: 24,   dist: 800 },
    // Middle East / Africa
    { lat: 27, lon: 48,   dist: 800 }, { lat: 6,  lon: 20,   dist: 800 },
    // Asia
    { lat: 22, lon: 78,   dist: 800 }, { lat: 31, lon: 116,  dist: 800 },
    { lat: 12, lon: 105,  dist: 800 }, { lat: 36, lon: 133,  dist: 700 },
    // Oceania / South America
    { lat: -31, lon: 147, dist: 800 }, { lat: -15, lon: -48, dist: 800 },
    { lat: -35, lon: -63, dist: 700 },
  ];

  try {
    const results = await pool(regions, 4, ({ lat, lon, dist }) =>
      fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      }).then(r => (r.ok ? r.json().then(d => d.ac || []) : []))
       .catch(() => [])
    );

    const seen = new Set();
    const allAircraft = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const ac of result.value) {
          if (ac.hex && !seen.has(ac.hex)) { seen.add(ac.hex); allAircraft.push(ac); }
        }
      }
    }

    if (allAircraft.length === 0) {
      return res.status(503).json({ error: 'Flight data source unavailable.', flights: [], total: 0 });
    }

    // Even global spread, then cap the number of markers the map draws.
    const shaped = shapeAdsb(allAircraft);
    shaped.sort((a, b) => a.lon - b.lon);
    const MAX_MARKERS = 300;
    const step = Math.max(1, Math.floor(shaped.length / MAX_MARKERS));
    const flights = shaped.filter((_, i) => i % step === 0).slice(0, MAX_MARKERS);

    // Fill origin/destination for the markers we're actually showing.
    await enrichRoutes(flights);

    // Vercel edge-caches the response, so many visitors = one upstream refresh.
    res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=90');
    return res.status(200).json({
      flights,
      total: allAircraft.length,
      shown: flights.length,
      source: 'adsb-lol',
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error', flights: [], total: 0 });
  }
}
