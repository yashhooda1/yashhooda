export const maxDuration = 60;

const ABUSEIPDB_KEY = process.env.ABUSEIPDB_API_KEY;
const VIRUSTOTAL_KEY = process.env.VIRUSTOTAL_API_KEY;
const HIBP_KEY = process.env.HIBP_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Breach Check via HaveIBeenPwned ──────────────────────────────────────────
async function checkBreach(email) {
  if (!HIBP_KEY) {
    // Fallback: AI-powered analysis
    return await aiFallback('breach', email);
  }

  const res = await fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
    {
      headers: {
        'hibp-api-key': HIBP_KEY,
        'User-Agent': 'YashHoodaPortfolio',
      },
    }
  );

  if (res.status === 404) {
    return { found: false, breaches: [], message: 'No breaches found for this email.' };
  }
  if (res.status === 401) {
    return { error: 'Invalid HIBP API key.' };
  }
  if (!res.ok) {
    return { error: `HIBP API error: ${res.status}` };
  }

  const data = await res.json();
  return {
    found: true,
    count: data.length,
    breaches: data.map((b) => ({
      name: b.Name,
      domain: b.Domain,
      date: b.BreachDate,
      dataClasses: b.DataClasses,
      description: b.Description?.replace(/<[^>]*>/g, '').slice(0, 200) + '…',
    })),
  };
}

// ── Threat Intelligence via AbuseIPDB ────────────────────────────────────────
async function checkThreatIntel(ip) {
  if (!ABUSEIPDB_KEY) {
    return await aiFallback('threat', ip);
  }

  const res = await fetch(
    `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`,
    {
      headers: {
        Key: ABUSEIPDB_KEY,
        Accept: 'application/json',
      },
    }
  );

  if (!res.ok) {
    return { error: `AbuseIPDB error: ${res.status}` };
  }

  const { data } = await res.json();
  return {
    ip: data.ipAddress,
    abuseScore: data.abuseConfidenceScore,
    country: data.countryCode,
    isp: data.isp,
    domain: data.domain,
    totalReports: data.totalReports,
    lastReported: data.lastReportedAt,
    isPublic: data.isPublic,
    usageType: data.usageType,
    isTor: data.isTor,
    isVpn: data.isVpn,
    riskLevel:
      data.abuseConfidenceScore >= 75
        ? 'CRITICAL'
        : data.abuseConfidenceScore >= 40
        ? 'HIGH'
        : data.abuseConfidenceScore >= 10
        ? 'MEDIUM'
        : 'LOW',
  };
}

// ── Domain Reputation via VirusTotal ─────────────────────────────────────────
async function checkDomainRep(domain) {
  if (!VIRUSTOTAL_KEY) {
    return await aiFallback('reputation', domain);
  }

  // Clean domain
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*/, '').trim();

  const res = await fetch(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(cleanDomain)}`, {
    headers: { 'x-apikey': VIRUSTOTAL_KEY },
  });

  if (res.status === 404) {
    return { error: 'Domain not found in VirusTotal database.' };
  }
  if (!res.ok) {
    return { error: `VirusTotal error: ${res.status}` };
  }

  const json = await res.json();
  const attr = json.data?.attributes || {};
  const stats = attr.last_analysis_stats || {};
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const malicious = stats.malicious || 0;
  const suspicious = stats.suspicious || 0;

  return {
    domain: cleanDomain,
    maliciousVendors: malicious,
    suspiciousVendors: suspicious,
    totalVendors: total,
    reputation: attr.reputation,
    categories: attr.categories ? Object.values(attr.categories).slice(0, 5) : [],
    lastAnalysis: attr.last_analysis_date
      ? new Date(attr.last_analysis_date * 1000).toISOString().split('T')[0]
      : null,
    riskLevel:
      malicious >= 10
        ? 'CRITICAL'
        : malicious >= 3
        ? 'HIGH'
        : malicious >= 1 || suspicious >= 3
        ? 'MEDIUM'
        : 'LOW',
    flaggedVendors: attr.last_analysis_results
      ? Object.entries(attr.last_analysis_results)
          .filter(([, v]) => v.category === 'malicious' || v.category === 'suspicious')
          .map(([vendor, v]) => `${vendor} (${v.category})`)
          .slice(0, 8)
      : [],
  };
}

// ── Paste Monitor via Claude AI ───────────────────────────────────────────────
async function checkPasteMonitor(query) {
  if (!ANTHROPIC_KEY) return { error: 'Anthropic API key not configured.' };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: `You are a cybersecurity threat intelligence analyst. Analyze whether the following email or domain "${query}" is commonly associated with dark web paste sites, data leaks, or underground forums based on your training data. 

Provide a structured threat assessment:
1. Known exposure risk (HIGH/MEDIUM/LOW/UNKNOWN)
2. Common paste site patterns for this type of target
3. Recommended protective actions
4. Dark web exposure indicators

Be factual and educational. Format as JSON with keys: riskLevel, pasteExposure, patterns, recommendations, indicators.`,
        },
      ],
    }),
  });

  if (!res.ok) return { error: 'AI analysis failed.' };

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return { aiAnalysis: true, ...JSON.parse(jsonMatch[0]) };
    }
  } catch (_) {}

  return { aiAnalysis: true, rawAnalysis: text };
}

// ── AI Fallback for missing API keys ─────────────────────────────────────────
async function aiFallback(type, target) {
  if (!ANTHROPIC_KEY) return { error: 'API key not configured.' };

  const prompts = {
    breach: `As a cybersecurity analyst, provide an educational threat assessment for the email domain "${target.split('@')[1] || target}". Discuss common breach patterns, data exposure risks, and protective measures. Format as JSON with keys: riskLevel, commonBreaches, recommendations, note (that this is educational, not a live lookup).`,
    threat: `As a cybersecurity analyst, assess the IP address "${target}" based on common threat intelligence patterns. Is it in known ranges for VPNs, Tor exit nodes, or botnets? Format as JSON with keys: riskLevel, analysis, usageType, recommendations, note.`,
    reputation: `As a cybersecurity analyst, assess the domain "${target}" reputation. Discuss common reputation factors, potential risks, and security posture. Format as JSON with keys: riskLevel, analysis, categories, recommendations, note (that this is educational, not a live lookup).`,
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompts[type] }],
    }),
  });

  if (!res.ok) return { error: 'AI fallback failed.' };

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return { aiPowered: true, ...JSON.parse(jsonMatch[0]) };
  } catch (_) {}

  return { aiPowered: true, rawAnalysis: text };
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tool, target } = req.body;

  if (!tool || !target) {
    return res.status(400).json({ error: 'Missing tool or target' });
  }

  // Basic input sanitization
  const cleanTarget = String(target).trim().slice(0, 256);

  try {
    let result;

    switch (tool) {
      case 'breach':
        // Validate email format
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTarget)) {
          return res.status(400).json({ error: 'Invalid email address format' });
        }
        result = await checkBreach(cleanTarget);
        break;

      case 'threat':
        // Validate IP or domain
        result = await checkThreatIntel(cleanTarget);
        break;

      case 'reputation':
        result = await checkDomainRep(cleanTarget);
        break;

      case 'paste':
        result = await checkPasteMonitor(cleanTarget);
        break;

      default:
        return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }

    return res.status(200).json({ tool, target: cleanTarget, result });
  } catch (err) {
    console.error('[darkweb] error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
