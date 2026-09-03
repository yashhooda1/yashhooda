// lib/gateway.js
import { getAuthUser }     from './auth.js';
import { checkKillSwitch } from './killSwitch.js';

export const ALLOWED_ORIGINS = new Set([
  'https://yashhooda.ai',
  'https://www.yashhooda.ai',
  'https://yashhooda1.vercel.app',
]);

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

export function isAdminRequest(req, authUser) {
  const pw = req.body?.adminPassword;
  return !!(
    (pw && process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD) ||
    (authUser && authUser.plan === 'admin')
  );
}

// auth: 'user' (JWT required) | 'admin' | 'none'
export async function gate(req, res, {
  endpoint,
  methods         = ['POST'],
  auth            = 'user',
  requireVerified = true,
  enforceOrigin   = true,
} = {}) {
  const origin = req.headers.origin || '';

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return { ok: false }; }

  if (!methods.includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return { ok: false };
  }

  const user    = getAuthUser(req);
  const isAdmin = isAdminRequest(req, user);

  if (enforceOrigin && !isAdmin && req.method !== 'GET' && !ALLOWED_ORIGINS.has(origin)) {
    console.warn(`[GATE:${endpoint}] bad origin="${origin}" ip=${clientIp(req)}`);
    res.status(403).json({ error: 'Forbidden.' });
    return { ok: false };
  }

  if (auth === 'admin' && !isAdmin) {
    res.status(403).json({ error: 'admin_required' });
    return { ok: false };
  }

  if (auth === 'user' && !isAdmin) {
    if (!user) {
      console.warn(`[GATE:${endpoint}] unauthenticated ip=${clientIp(req)}`);
      res.status(401).json({ error: 'login_required', message: 'Please log in to use this feature.' });
      return { ok: false };
    }
    if (requireVerified && user.verified === false) {
      res.status(403).json({ error: 'email_unverified', message: 'Please verify your email first.' });
      return { ok: false };
    }
  }

  const ks = await checkKillSwitch(endpoint, isAdmin);
  if (!ks.ok) { res.status(ks.status).json(ks.body); return { ok: false }; }

  return { ok: true, user, isAdmin, ip: clientIp(req) };
}
