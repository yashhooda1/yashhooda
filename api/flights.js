export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Shape ADS-B aircraft records ──
  function shapeAdsb(aircraft) {
    return aircraft
      .filter(a => a.lat && a.lon && !a.gnd)
      .map(a => ({
        icao:        a.hex || null,
        callsign:    a.flight?.trim() || a.hex || null,
        country:     null,
        airline:     null,
        origin:      null,
        origin_iata: null,
        dest:        null,
        dest_iata:   null,
        lat:         parseFloat(a.lat),
        lon:         parseFloat(a.lon),
        altitude_ft: a.alt_baro || a.alt_geom || 0,
        speed_mph:   a.gs ? Math.round(a.gs) : 0,
        heading:     Math.round(a.track || 0),
        vertical_ms: a.baro_rate ? a.baro_rate / 196.85 : 0,
        is_ground:   false,
      }))
      .filter(f => f.altitude_ft > 500);
  }

  // ── Fetch route data for a callsign from adsbdb (free, no key) ──
  async function getRoute(callsign) {
    if (!callsign || callsign.length < 4) return null;
    try {
      const r = await fetch(`https://api.adsbdb.com/v0/callsign/${callsign}`, {
        signal: AbortSignal.timeout(3000),
        headers: { 'User-Agent': 'YashHoodaPortfolio/1.0' },
      });
      if (!r.ok) return null;
      const d = await r.json();
      const route = d?.response?.flightroute;
      if (!route) return null;
      return {
        airline:     route.airline?.name || null,
        origin:      route.origin?.name || null,
        origin_iata: route.origin?.iata_code || null,
        origin_city: route.origin?.municipality || null,
        dest:        route.destination?.name || null,
        dest_iata:   route.destination?.iata_code || null,
        dest_city:   route.destination?.municipality || null,
      };
    } catch { return null; }
  }

  try {
    let flights = [];
    let total = 0;
    let source = '';

    // ── Strategy: fetch multiple regions in parallel for full US coverage ──
    // Split US into quadrants to guarantee geographic spread
    const regions = [
      // Northwest
      { lat: 45.0, lon: -115.0, dist: 800 },
      // Southwest
      { lat: 33.0, lon: -115.0, dist: 800 },
      // North Central
      { lat: 45.0, lon: -95.0,  dist: 800 },
      // South Central (Texas/Gulf)
      { lat: 30.0, lon: -95.0,  dist: 800 },
      // Northeast
      { lat: 43.0, lon: -73.0,  dist: 700 },
      // Southeast
      { lat: 32.0, lon: -83.0,  dist: 700 },
    ];

    const regionResults = await Promise.allSettled(
      regions.map(async ({ lat, lon, dist }) => {
        const r = await fetch(
          `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
          {
            headers: { 'User-Agent': 'YashHoodaPortfolio/1.0', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return d.ac || [];
      })
    );

    // Merge all regions, deduplicate by hex
    const seen = new Set();
    const allAircraft = [];
    for (const result of regionResults) {
      if (result.status === 'fulfilled') {
        for (const ac of result.value) {
          if (ac.hex && !seen.has(ac.hex)) {
            seen.add(ac.hex);
            allAircraft.push(ac);
          }
        }
      }
    }

    if (allAircraft.length > 0) {
      source = 'adsb-lol-multiregion';
      total = allAircraft.length;
      // Take up to 200 spread across the US — sort by distribution
      const shaped = shapeAdsb(allAircraft);
      // Spread selection: sort by longitude to get east-west coverage
      shaped.sort((a, b) => a.lon - b.lon);
      const step = Math.max(1, Math.floor(shaped.length / 200));
      flights = shaped.filter((_, i) => i % step === 0).slice(0, 200);
    } else {
      // Fallback: adsb.fi global
      source = 'adsb-fi';
      const fallback = await fetch(
        'https://api.adsb.fi/v1/flights?lat=39.5&lon=-98.35&radius=3000',
        {
          headers: { 'User-Agent': 'YashHoodaPortfolio/1.0' },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (fallback.ok) {
        const fd = await fallback.json();
        const ac = fd.ac || fd.aircraft || [];
        total = ac.length;
        flights = shapeAdsb(ac).slice(0, 200);
      }
    }

    if (flights.length === 0) {
      return res.status(503).json({
        error: 'Flight data temporarily unavailable. Try again in a moment.',
        flights: [], total: 0,
      });
    }

    // ── Enrich top 30 flights with route data (parallel, capped to avoid rate limits) ──
    const toEnrich = flights
      .filter(f => f.callsign && /^[A-Z]{2,3}\d+/.test(f.callsign)) // airline callsigns only
      .slice(0, 30);

    const routeResults = await Promise.allSettled(
      toEnrich.map(f => getRoute(f.callsign))
    );

    // Map enriched routes back onto flights
    const routeMap = new Map();
    toEnrich.forEach((f, i) => {
      const result = routeResults[i];
      if (result.status === 'fulfilled' && result.value) {
        routeMap.set(f.callsign, result.value);
      }
    });

    flights = flights.map(f => {
      const route = routeMap.get(f.callsign);
      if (route) {
        return {
          ...f,
          airline:      route.airline,
          origin:       route.origin_city || route.origin,
          origin_iata:  route.origin_iata,
          dest:         route.dest_city || route.dest,
          dest_iata:    route.dest_iata,
        };
      }
      return f;
    });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      flights,
      total,
      source,
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
