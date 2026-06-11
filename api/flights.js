export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Helper to shape ADS-B Exchange aircraft records
  function shapeAdsb(aircraft) {
    return aircraft
      .filter(a => a.lat && a.lon && !a.gnd)
      .map(a => ({
        icao:        a.hex || null,
        callsign:    a.flight?.trim() || a.hex || null,
        country:     null,
        airline:     null,
        origin:      null,
        dest:        null,
        lat:         a.lat,
        lon:         a.lon,
        altitude_ft: a.alt_baro || a.alt_geom || 0,
        speed_mph:   a.gs ? Math.round(a.gs) : 0,
        heading:     Math.round(a.track || 0),
        vertical_ms: a.baro_rate ? a.baro_rate / 196.85 : 0,
        is_ground:   false,
      }))
      .filter(f => f.altitude_ft > 500)
      .slice(0, 250);
  }

  // Try each source in order, return first success
  const sources = [
    // ADS-B Exchange via adsb.lol — center of US, 2500nm radius covers full country
    {
      name: 'adsb-lol-wide',
      url: 'https://api.adsb.lol/v2/lat/39.5/lon/-98.35/dist/2500',
      parse: async (r) => {
        const d = await r.json();
        const ac = d.ac || [];
        return { flights: shapeAdsb(ac), total: ac.length };
      }
    },
    // ADS-B Exchange via adsb.lol — eastern US
    {
      name: 'adsb-lol-east',
      url: 'https://api.adsb.lol/v2/lat/38.0/lon/-80.0/dist/1200',
      parse: async (r) => {
        const d = await r.json();
        const ac = d.ac || [];
        return { flights: shapeAdsb(ac), total: ac.length };
      }
    },
    // ADS-B Exchange via adsb.lol — western US
    {
      name: 'adsb-lol-west',
      url: 'https://api.adsb.lol/v2/lat/38.0/lon/-115.0/dist/1200',
      parse: async (r) => {
        const d = await r.json();
        const ac = d.ac || [];
        return { flights: shapeAdsb(ac), total: ac.length };
      }
    },
    // Fallback: adsb.fi (another free ADS-B aggregator)
    {
      name: 'adsb-fi',
      url: 'https://api.adsb.fi/v1/flights?lat=39.5&lon=-98.35&radius=2500',
      parse: async (r) => {
        const d = await r.json();
        const ac = d.ac || d.aircraft || [];
        return { flights: shapeAdsb(ac), total: ac.length };
      }
    },
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'YashHoodaPortfolio/1.0',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        console.warn(`[Flights] ${source.name} returned ${response.status}`);
        continue;
      }

      const { flights, total } = await source.parse(response);

      if (flights.length === 0) {
        console.warn(`[Flights] ${source.name} returned 0 flights`);
        continue;
      }

      console.log(`[Flights] ${source.name} success: ${flights.length} flights`);
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({
        flights,
        total,
        source: source.name,
        timestamp: Date.now(),
      });

    } catch (err) {
      console.warn(`[Flights] ${source.name} failed: ${err.message}`);
      continue;
    }
  }

  // All sources failed
  console.error('[Flights] All sources failed');
  return res.status(503).json({
    error: 'Flight data temporarily unavailable — all sources timed out. Try again in a moment.',
    flights: [],
    total: 0,
  });
}
