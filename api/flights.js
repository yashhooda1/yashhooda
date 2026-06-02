export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // US bounding box: lat 24-49, lon -125 to -66
    const url = 'https://opensky-network.org/api/states/all?lamin=24&lomin=-125&lamax=49&lomax=-66';
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'OpenSky fetch failed' });
    }

    const data = await response.json();
    const states = data.states || [];

    // Shape and filter — only airborne flights with valid position
    const flights = states
      .filter(s => s[5] && s[6] && s[8] === false) // has lon, lat, is airborne
      .map(s => ({
        icao:        s[0]?.trim() || null,
        callsign:    s[1]?.trim() || null,
        country:     s[2] || null,
        lon:         s[5],
        lat:         s[6],
        altitude_m:  s[7] || 0,
        altitude_ft: s[7] ? Math.round(s[7] * 3.28084) : 0,
        on_ground:   s[8],
        speed_ms:    s[9] || 0,
        speed_mph:   s[9] ? Math.round(s[9] * 2.23694) : 0,
        heading:     s[10] || 0,
        vertical_ms: s[11] || 0,
      }))
      .slice(0, 200); // cap at 200 for performance

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ flights, total: states.length, timestamp: Date.now() });

  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
