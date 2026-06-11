export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // ── Primary: OpenSky Network (free, no key, best coverage) ──
    // US bounding box: lat 24-49, lon -125 to -66
    const openSkyUrl = 'https://opensky-network.org/api/states/all?lamin=24&lomin=-125&lamax=49&lomax=-66';

    let flights = [];
    let total = 0;
    let source = 'opensky';

    const openSkyRes = await fetch(openSkyUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'YashHoodaPortfolio/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (openSkyRes.ok) {
      const data = await openSkyRes.json();
      const states = data.states || [];
      total = states.length;

      flights = states
        .filter(s => s[5] && s[6] && s[8] === false) // has lon, lat, is airborne
        .map(s => ({
          icao:        s[0]?.trim() || null,
          callsign:    s[1]?.trim() || null,
          country:     s[2] || null,
          airline:     null,
          origin:      null,
          dest:        null,
          lat:         s[6],
          lon:         s[5],
          altitude_ft: s[7] ? Math.round(s[7] * 3.28084) : 0,
          speed_mph:   s[9] ? Math.round(s[9] * 2.23694) : 0,
          heading:     Math.round(s[10] || 0),
          vertical_ms: s[11] || 0,
          is_ground:   s[8] || false,
        }))
        .filter(f => f.altitude_ft > 1000) // filter out ground-hugging readings
        .slice(0, 250);

    } else {
      // ── Fallback: ADS-B Exchange public API (no key needed) ──
      source = 'adsbexchange';
      const adsbUrl = 'https://api.adsb.lol/v2/lat/39.5/lon/-98.35/dist/2500';
      const adsbRes = await fetch(adsbUrl, {
        headers: { 'User-Agent': 'YashHoodaPortfolio/1.0' },
        signal: AbortSignal.timeout(8000),
      });

      if (adsbRes.ok) {
        const adsbData = await adsbRes.json();
        const aircraft = adsbData.ac || [];
        total = aircraft.length;

        flights = aircraft
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
            is_ground:   a.gnd || false,
          }))
          .filter(f => f.altitude_ft > 1000)
          .slice(0, 250);
      } else {
        // ── Final fallback: smaller ADS-B Exchange regional query ──
        source = 'adsbexchange-regional';
        const regional = await fetch('https://api.adsb.lol/v2/lat/37.5/lon/-95.0/dist/1500', {
          headers: { 'User-Agent': 'YashHoodaPortfolio/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (regional.ok) {
          const rData = await regional.json();
          const aircraft = rData.ac || [];
          total = aircraft.length;
          flights = aircraft
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
              is_ground:   a.gnd || false,
            }))
            .filter(f => f.altitude_ft > 1000)
            .slice(0, 250);
        }
      }
    }

    if (flights.length === 0) {
      return res.status(503).json({ error: 'All flight data sources unavailable — try again in a moment.' });
    }

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
