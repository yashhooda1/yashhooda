export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FlightAware API key missing' });

  try {
    // FlightAware AeroAPI v4 — live flights in bounding box covering full world
    // We fetch multiple regions to get global coverage
    const headers = {
      'x-apikey': apiKey,
      'Accept': 'application/json; charset=UTF-8',
    };

    // Fetch live flights across major world regions in parallel
    const regions = [
      // North America
      { name: 'North America', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%2224+-125+50+-65%22&max_pages=2' },
      // Europe
      { name: 'Europe', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%2235+%20-10+72+40%22&max_pages=2' },
      // Asia Pacific
      { name: 'Asia Pacific', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%22-10+100+50+150%22&max_pages=2' },
      // Middle East / South Asia
      { name: 'Middle East', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%2210+40+40+80%22&max_pages=1' },
      // Latin America
      { name: 'Latin America', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%22-55+-85+15+-35%22&max_pages=1' },
    ];

    const results = await Promise.allSettled(
      regions.map(async (region) => {
        const r = await fetch(region.url, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
          console.warn(`[Flights] ${region.name} returned ${r.status}`);
          return [];
        }
        const d = await r.json();
        return (d.flights || []).map(f => ({ ...f, _region: region.name }));
      })
    );

    // Merge + deduplicate by fa_flight_id
    const seen = new Set();
    const allFlights = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const f of result.value) {
          const id = f.fa_flight_id || f.ident;
          if (id && !seen.has(id)) {
            seen.add(id);
            allFlights.push(f);
          }
        }
      }
    }

    // Shape into clean format
    const flights = allFlights
      .filter(f => f.last_position?.latitude && f.last_position?.longitude)
      .map(f => {
        const pos = f.last_position;
        const origin = f.origin;
        const dest   = f.destination;

        // Airline ICAO prefix for logo lookup
        const airlineIcao = f.operator_icao || f.ident?.match(/^[A-Z]{3}/)?.[0] || null;

        return {
          fa_flight_id: f.fa_flight_id,
          icao:         f.ident_icao || null,
          callsign:     f.ident || f.ident_iata || null,
          airline:      f.operator || null,
          airline_icao: airlineIcao,
          airline_iata: f.operator_iata || null,
          // Airline logo via Clearbit (free) or airline IATA
          airline_logo: f.operator_iata
            ? `https://content.airhex.com/content/logos/airlines_${f.operator_iata}_32_32_s.png`
            : null,
          // Origin
          origin:       origin?.city || origin?.name || null,
          origin_iata:  origin?.code_iata || null,
          origin_icao:  origin?.code_icao || null,
          origin_name:  origin?.name || null,
          // Destination
          dest:         dest?.city || dest?.name || null,
          dest_iata:    dest?.code_iata || null,
          dest_icao:    dest?.code_icao || null,
          dest_name:    dest?.name || null,
          // Position
          lat:          pos.latitude,
          lon:          pos.longitude,
          altitude_ft:  pos.altitude || 0,
          speed_mph:    pos.groundspeed ? Math.round(pos.groundspeed) : 0,
          heading:      Math.round(pos.heading || 0),
          vertical_fpm: pos.vertical_rate || 0,
          // Flight info
          aircraft_type: f.aircraft_type || null,
          status:        f.status || null,
          departure_time: f.scheduled_out || f.actual_out || null,
          arrival_time:   f.scheduled_in  || f.estimated_in || null,
          progress_pct:   f.progress_percent || null,
          region:         f._region,
        };
      });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      flights,
      total: allFlights.length,
      shown: flights.length,
      source: 'flightaware-aeroapi',
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
