export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { league } = req.query;
  const validLeagues = ['nba', 'mlb', 'mls', 'nfl'];
  if (!league || !validLeagues.includes(league)) {
    return res.status(400).json({ error: 'Invalid league. Use: nba, mlb, mls, nfl' });
  }

  try {
    // Use the SportRadar-backed internal data source
    const baseUrl = 'https://api.sofascore.com/api/v1';
    let url = '';
    const today = new Date().toISOString().split('T')[0];

    // Map league to Sofascore tournament IDs
    const tournamentMap = {
      nba: '/sport/basketball/category/120/seasons',
      mlb: '/sport/baseball/category/1/seasons',
      mls: '/sport/football/category/242/seasons',
      nfl: '/sport/american-football/category/1/seasons',
    };

    // Use a reliable free sports API — ESPN public endpoints
    const espnLeagueMap = {
      nba: 'basketball/nba',
      mlb: 'baseball/mlb',
      mls: 'soccer/usa.1',
      nfl: 'football/nfl',
    };

    const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/${espnLeagueMap[league]}/scoreboard`;
    const response = await fetch(espnUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: `ESPN API returned ${response.status}` });
    }

    const data = await response.json();
    const events = data.events || [];

    const games = events.map(event => {
      const comp = event.competitions?.[0];
      const competitors = comp?.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return null;

      const status = event.status?.type?.name?.toLowerCase() || 'scheduled';
      const isFinal = status === 'status_final' || status.includes('final');
      const isLive = status === 'status_in_progress' || status.includes('progress');
      const isScheduled = !isFinal && !isLive;

      const homeAbbr = home.team?.abbreviation || 'HOME';
      const awayAbbr = away.team?.abbreviation || 'AWAY';

      const gameStatus = isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled';

      const score = {};
      if (home.score !== undefined) score[homeAbbr] = parseInt(home.score);
      if (away.score !== undefined) score[awayAbbr] = parseInt(away.score);

      // Win probability
      const winProb = {};
      const situation = comp?.situation;
      if (home.statistics) {
        const homeWinProb = home.statistics?.find?.(s => s.name === 'winProbability')?.value;
        if (homeWinProb !== undefined) {
          winProb[homeAbbr] = parseFloat((homeWinProb * 100).toFixed(1));
          winProb[awayAbbr] = parseFloat(((1 - homeWinProb) * 100).toFixed(1));
        }
      }

      const startDate = new Date(event.date);
      const localStart = startDate.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago'
      }) + ' CDT';

      return {
        id: event.id,
        status: gameStatus,
        start_time: event.date,
        local_start: localStart,
        home: homeAbbr,
        away: awayAbbr,
        title: comp?.notes?.[0]?.headline || event.name || null,
        teams: {
          [homeAbbr]: { name: home.team?.displayName || homeAbbr, abbreviation: homeAbbr },
          [awayAbbr]: { name: away.team?.displayName || awayAbbr, abbreviation: awayAbbr },
        },
        score: Object.keys(score).length ? score : undefined,
        win_probability: Object.keys(winProb).length ? winProb : undefined,
      };
    }).filter(Boolean);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ league, games, total: games.length });

  } catch (err) {
    console.error(`Sports handler error (${league}):`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
