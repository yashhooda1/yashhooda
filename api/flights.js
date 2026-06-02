export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.AVIATIONSTACK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AviationStack API key missing' });

  try {
    // Fetch live flights — filter to US
    const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_status=active&limit=100`;
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });

    if (!response.ok) {
      const err = await response.text();
      console.error('AviationStack error:', err);
      return res.status(502).json({ error: 'AviationStack fetch failed' });
    }

    const data = await response.json();

    if (data.error) {
      console.error('AviationStack API error:', data.error);
      return res.status(502).json({ error: data.error.info || 'API error' });
    }

    const rawFlights = data.data || [];

    // Shape and filter — only flights with live position data
    const flights = rawFlights
      .filter(f => f.live && f.live.latitude && f.live.longitude)
      .map(f => ({
        icao:        f.flight?.icao || null,
        callsign:    f.flight?.iata || f.flight?.icao || null,
        airline:     f.airline?.name || null,
        origin:      f.departure?.airport || null,
        origin_iata: f.departure?.iata || null,
        dest:        f.arrival?.airport || null,
        dest_iata:   f.arrival?.iata || null,
        lat:         f.live?.latitude,
        lon:         f.live?.longitude,
        altitude_ft: Math.round((f.live?.altitude || 0) * 3.28084),
        speed_mph:   Math.round((f.live?.speed_horizontal || 0) * 0.621371),
        heading:     Math.round(f.live?.direction || 0),
        vertical_ms: f.live?.speed_vertical || 0,
        is_ground:   f.live?.is_ground || false,
        status:      f.flight_status || null,
      }))
      .filter(f => !f.is_ground); // airborne only

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      flights,
      total: rawFlights.length,
      timestamp: Date.now()
    });

  } catch (err) {
    console.error('Flights error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
