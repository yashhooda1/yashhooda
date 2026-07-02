export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { league, id } = req.query;
  const validLeagues = ['nba','mlb','mls','nfl','worldcup','rockets','astros','texans'];
  if (!league || !validLeagues.includes(league)) {
    return res.status(400).json({ error: `Invalid league. Use: ${validLeagues.join(', ')}` });
  }
  if (!id) return res.status(400).json({ error: 'Missing game id' });

  const espnLeagueMap = {
    nba:'basketball/nba', mlb:'baseball/mlb', mls:'soccer/usa.1',
    nfl:'football/nfl', worldcup:'soccer/fifa.world',
    rockets:'basketball/nba', astros:'baseball/mlb', texans:'football/nfl',
  };
  const path = espnLeagueMap[league];
  const sportType = path.split('/')[0];

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${id}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`ESPN summary ${r.status}`);
    const d = await r.json();

    // ── Header / teams ──
    const comp = d.header?.competitions?.[0] || {};
    const competitors = comp.competitors || [];
    const homeC = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
    const awayC = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};

    const teamMeta = (c) => ({
      abbr:   c.team?.abbreviation || '',
      name:   c.team?.displayName || c.team?.abbreviation || '',
      logo:   c.team?.logos?.[0]?.href || c.team?.logo || null,
      score:  c.score != null ? Number(c.score) : null,
      record: c.record?.[0]?.summary || c.records?.[0]?.summary || null,
      winner: c.winner || false,
    });
    const home = teamMeta(homeC);
    const away = teamMeta(awayC);

    const status      = comp.status?.type || {};
    const statusState = (status.state || '').toLowerCase();
    const gameStatus  = statusState === 'post' ? 'closed' : statusState === 'in' ? 'inprogress' : 'scheduled';
    const statusDetail = status.detail || status.shortDetail || null;

    // ── Team statistics (generic label/value across sports) ──
    const bt = d.boxscore?.teams || [];
    const findTeamStats = (side, homeAway) => {
      const entry = bt.find(t => t.homeAway === homeAway)
                 || bt.find(t => t.team?.abbreviation === side.abbr)
                 || {};
      return entry.statistics || [];
    };
    const homeTS = findTeamStats(home, 'home');
    const awayTS = findTeamStats(away, 'away');

    const labelOf = (s) => s.label || s.displayName || s.name;
    const labels = new Set([...homeTS.map(labelOf), ...awayTS.map(labelOf)].filter(Boolean));
    const teamStats = [];
    labels.forEach(label => {
      const h = homeTS.find(s => labelOf(s) === label);
      const a = awayTS.find(s => labelOf(s) === label);
      teamStats.push({
        label,
        home: h?.displayValue ?? '—',
        away: a?.displayValue ?? '—',
      });
    });

    // ── Player leaders ──
    const leaders = [];
    (d.leaders || []).forEach(block => {
      const teamAbbr = block.team?.abbreviation || '';
      (block.leaders || []).forEach(cat => {
        const top = cat.leaders?.[0];
        if (top) {
          leaders.push({
            category: cat.displayName || cat.name || '',
            team: teamAbbr,
            player: top.athlete?.displayName || top.athlete?.shortName || '',
            value: top.displayValue || '',
          });
        }
      });
    });

    // ── Scoring / key plays (baseball & football use scoringPlays; soccer uses keyEvents) ──
    const rawPlays = d.scoringPlays || d.keyEvents || d.scoringplays || [];
    const scoringPlays = rawPlays.slice(-14).map(p => ({
      period: p.period?.displayValue || p.period?.number || '',
      clock:  p.clock?.displayValue || '',
      team:   p.team?.abbreviation || '',
      text:   p.text || p.shortText || '',
      home:   p.homeScore ?? null,
      away:   p.awayScore ?? null,
    })).filter(p => p.text);

    // ── Win probability (final data point) ──
    let winProb = null;
    if (Array.isArray(d.winprobability) && d.winprobability.length) {
      const last = d.winprobability[d.winprobability.length - 1];
      const homePct = last.homeWinPercentage != null ? +(last.homeWinPercentage * 100).toFixed(1) : null;
      if (homePct != null) {
        winProb = { [home.abbr]: homePct, [away.abbr]: +(100 - homePct).toFixed(1) };
      }
    }

    // ── Venue / broadcast / odds ──
    const venue = d.gameInfo?.venue?.fullName || comp.venue?.fullName || null;
    const broadcast = comp.broadcasts?.[0]?.names?.[0]
                   || comp.geoBroadcasts?.[0]?.media?.shortName
                   || null;
    const odds = d.pickcenter?.[0] || d.odds?.[0] || null;
    const oddsSummary = odds ? {
      details:    odds.details || null,
      overUnder:  odds.overUnder || null,
      favorite:   odds.homeTeamOdds?.favorite ? home.abbr
                : odds.awayTeamOdds?.favorite ? away.abbr : null,
    } : null;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      league, id, sport: sportType,
      status: gameStatus, statusDetail,
      home, away,
      team_stats: teamStats,
      leaders,
      scoring_plays: scoringPlays,
      win_probability: winProb,
      venue, broadcast,
      odds: oddsSummary,
      source: 'espn',
    });

  } catch (err) {
    console.error(`Game detail error (${league}/${id}):`, err.message);
    return res.status(500).json({ error: 'Could not load game detail' });
  }
}
