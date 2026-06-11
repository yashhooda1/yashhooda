export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.FLIGHTAWARE_API_KEY;

  // ── ADS-B shape helper (fallback) ──
  function shapeAdsb(aircraft) {
    return aircraft
      .filter(a => a.lat && a.lon && !a.gnd)
      .map(a => {
        // Use geometric altitude preferably, fall back to baro
        const altGeom = a.alt_geom && a.alt_geom > 1000 ? a.alt_geom : null;
        const altBaro = a.alt_baro && a.alt_baro > 1000 ? a.alt_baro : null;
        const altitude_ft = altGeom || altBaro || 0;
        return {
          icao:        a.hex || null,
          callsign:    a.flight?.trim() || a.hex || null,
          airline:     null,
          origin:      null, origin_iata: null,
          dest:        null, dest_iata:   null,
          lat:         parseFloat(a.lat),
          lon:         parseFloat(a.lon),
          altitude_ft,
          speed_mph:   a.gs ? Math.round(a.gs) : 0,
          heading:     Math.round(a.track || 0),
          vertical_fpm: a.baro_rate || 0,
          aircraft_type: a.t || null,
          source:      'adsb',
        };
      })
      .filter(f => f.altitude_ft > 1000);
  }

  try {
    // ══════════════════════════════════════════
    // PRIMARY: FlightAware AeroAPI (if key set)
    // ══════════════════════════════════════════
    if (apiKey) {
      const headers = {
        'x-apikey': apiKey,
        'Accept': 'application/json; charset=UTF-8',
      };

      const regions = [
        { name: 'North America', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%2224+-125+50+-65%22&max_pages=2' },
        { name: 'Europe',        url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%2235+-10+72+40%22&max_pages=2' },
        { name: 'Asia Pacific',  url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%22-10+100+50+150%22&max_pages=2' },
        { name: 'Middle East',   url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%2210+40+40+80%22&max_pages=1' },
        { name: 'Latin America', url: 'https://aeroapi.flightaware.com/aeroapi/flights/search?query=-latlong+%22-55+-85+15+-35%22&max_pages=1' },
      ];

      const results = await Promise.allSettled(
        regions.map(async (region) => {
          const r = await fetch(region.url, { headers, signal: AbortSignal.timeout(10000) });
          if (!r.ok) { console.warn(`[Flights] ${region.name} returned ${r.status}`); return []; }
          const d = await r.json();
          return (d.flights || []).map(f => ({ ...f, _region: region.name }));
        })
      );

      const seen = new Set();
      const allFlights = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const f of result.value) {
            const id = f.fa_flight_id || f.ident;
            if (id && !seen.has(id)) { seen.add(id); allFlights.push(f); }
          }
        }
      }

      const flights = allFlights
        .filter(f => f.last_position?.latitude && f.last_position?.longitude)
        .map(f => {
          const pos    = f.last_position;
          const origin = f.origin;
          const dest   = f.destination;

          // ── FlightAware altitude fix ──
          // pos.altitude is in flight levels (hundreds of feet) — multiply by 100
          // but some responses give actual feet — detect by value range
          let altitude_ft = pos.altitude || 0;
          if (altitude_ft > 0 && altitude_ft < 1000) {
            // Almost certainly flight level format (e.g. 350 = FL350 = 35,000ft)
            altitude_ft = altitude_ft * 100;
          }

          return {
            fa_flight_id:  f.fa_flight_id,
            icao:          f.ident_icao || null,
            callsign:      f.ident || f.ident_iata || null,
            airline:       f.operator || null,
            airline_iata:  f.operator_iata || null,
            airline_logo:  f.operator_iata
              ? `https://content.airhex.com/content/logos/airlines_${f.operator_iata}_32_32_s.png`
              : null,
            origin:        origin?.city || origin?.name || null,
            origin_iata:   origin?.code_iata || null,
            origin_name:   origin?.name || null,
            dest:          dest?.city || dest?.name || null,
            dest_iata:     dest?.code_iata || null,
            dest_name:     dest?.name || null,
            lat:           pos.latitude,
            lon:           pos.longitude,
            altitude_ft,
            speed_mph:     pos.groundspeed ? Math.round(pos.groundspeed) : 0,
            heading:       Math.round(pos.heading || 0),
            vertical_fpm:  pos.vertical_rate || 0,
            aircraft_type: f.aircraft_type || null,
            status:        f.status || null,
            departure_time: f.scheduled_out || f.actual_out || null,
            arrival_time:   f.scheduled_in  || f.estimated_in || null,
            progress_pct:   f.progress_percent || null,
            region:         f._region,
            source:         'flightaware',
          };
        })
        .filter(f => f.altitude_ft > 1000); // filter out ground readings

      if (flights.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return res.status(200).json({
          flights,
          total: allFlights.length,
          shown: flights.length,
          source: 'flightaware-aeroapi',
          timestamp: Date.now(),
        });
      }
      // Fall through to ADS-B if FlightAware returned 0 valid flights
      console.warn('[Flights] FlightAware returned 0 valid flights, falling back to ADS-B');
    }

    // ══════════════════════════════════════════
    // FALLBACK: ADS-B Exchange multi-region
    // ══════════════════════════════════════════
    const regions = [
      { lat: 45.0, lon: -115.0, dist: 800 }, // NW USA
      { lat: 33.0, lon: -115.0, dist: 800 }, // SW USA
      { lat: 45.0, lon: -95.0,  dist: 800 }, // N Central
      { lat: 30.0, lon: -95.0,  dist: 800 }, // S Central / Texas
      { lat: 43.0, lon: -73.0,  dist: 700 }, // NE USA
      { lat: 32.0, lon: -83.0,  dist: 700 }, // SE USA
    ];

    const regionResults = await Promise.allSettled(
      regions.map(({ lat, lon, dist }) =>
        fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {
          headers: { 'User-Agent': 'YashHoodaPortfolio/1.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        }).then(r => r.ok ? r.json().then(d => d.ac || []) : [])
      )
    );

    const seen = new Set();
    const allAircraft = [];
    for (const result of regionResults) {
      if (result.status === 'fulfilled') {
        for (const ac of result.value) {
          if (ac.hex && !seen.has(ac.hex)) { seen.add(ac.hex); allAircraft.push(ac); }
        }
      }
    }

    if (allAircraft.length > 0) {
      const shaped = shapeAdsb(allAircraft);
      shaped.sort((a, b) => a.lon - b.lon);
      const step    = Math.max(1, Math.floor(shaped.length / 200));
      const flights = shaped.filter((_, i) => i % step === 0).slice(0, 200);

      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({
        flights,
        total: allAircraft.length,
        shown: flights.length,
        source: 'adsb-lol',
        timestamp: Date.now(),
      });
    }

    return res.status(503).json({ error: 'All flight data sources unavailable.', flights: [], total: 0 });

  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
