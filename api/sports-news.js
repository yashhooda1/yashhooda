export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { league } = req.query; // optional single league; omit for all

  const NEWS_SOURCES = {
    nba:      { path: 'basketball/nba',    label: 'NBA' },
    mlb:      { path: 'baseball/mlb',       label: 'MLB' },
    mls:      { path: 'soccer/usa.1',       label: 'MLS' },
    nfl:      { path: 'football/nfl',        label: 'NFL' },
    worldcup: { path: 'soccer/fifa.world',  label: 'World Cup' },
  };

  // Lightweight tag classifier so the front end can filter FA / trades / draft / rumors
  const tagOf = (text) => {
    const t = (text || '').toLowerCase();
    if (/\btrade[ds]?\b|traded\b|acquire/.test(t))                       return 'Trade';
    if (/free agen|\bsigns?\b|signing|agree[sd]? to|\bdeal\b|contract/.test(t)) return 'Free Agency';
    if (/\bdraft/.test(t))                                               return 'Draft';
    if (/rumor|rumour|reportedly|report:|linked|could sign|eyeing/.test(t)) return 'Rumor';
    if (/injur|out for|ruled out|questionable|day-to-day|sidelined/.test(t)) return 'Injury';
    return null;
  };

  const targets = league && NEWS_SOURCES[league]
    ? [[league, NEWS_SOURCES[league]]]
    : Object.entries(NEWS_SOURCES);

  const fetchNews = async ([key, cfg]) => {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/news`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.articles || []).map(a => {
        const headline = a.headline || a.title || '';
        const description = a.description || '';
        return {
          league: key,
          league_label: cfg.label,
          headline,
          description,
          published: a.published || a.lastModified || null,
          published_ms: a.published ? new Date(a.published).getTime() : 0,
          image: a.images?.[0]?.url || null,
          link: a.links?.web?.href || a.links?.mobile?.href || null,
          tag: tagOf(`${headline} ${description}`),
        };
      });
    } catch { return []; }
  };

  try {
    const results = await Promise.all(targets.map(fetchNews));
    let articles = results.flat();

    // Dedupe by headline
    const seen = new Set();
    articles = articles.filter(a => {
      const k = (a.headline || '').toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    articles.sort((a, b) => b.published_ms - a.published_ms);
    articles = articles.slice(0, 40);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ articles, total: articles.length, source: 'espn' });
  } catch (err) {
    console.error('News error:', err.message);
    return res.status(500).json({ error: 'Could not load news' });
  }
}
