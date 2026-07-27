// /api/flights — free global live-flight feed from adsb.lol (community ADS-B).
// No API key, no per-call cost. Replaces the paid FlightAware AeroAPI path.
//
// Returns the same JSON shape the map already expects, so no frontend change
// is needed. Airline is derived from the callsign on the frontend; raw ADS-B
// doesn't broadcast origin/destination, so those stay null (see note below).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

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
          origin:        null, origin_iata: null,
          dest:          null, dest_iata:   null,
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
    const results = await Promise.allSettled(
      regions.map(({ lat, lon, dist }) =>
        fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {
          headers: { 'User-Agent': 'YashHoodaPortfolio/1.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        }).then(r => (r.ok ? r.json().then(d => d.ac || []) : []))
         .catch(() => [])
      )
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
