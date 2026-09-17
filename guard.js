// Who is calling, and how much have they used — the two questions the shared secret can't answer.
//
// The app's secret ships inside the app bundle, so it proves "this is probably the Easy app", not
// "this is one person". Left at that, one extracted secret is an unmetered line to the OpenAI
// account. This module gives every request an identity and meters the expensive routes:
//
//   identity  Supabase access token (Authorization: Bearer …), verified against Supabase itself —
//             the server never trusts the token's claims unchecked. Without a verified token the
//             caller is identified by IP ONLY. The app's x-install-id header used to be accepted
//             as an identity, but a caller picks its own value, so a fresh id per request reset
//             the allowance every time. Every current app build sends a token.
//   metering  a rolling hourly and daily count of AI calls per identity, plus a plain per-IP
//             request limit. Limits are generous for a person and tiny for a script.
//
// Counts live in memory: this API is one process, and a restart forgetting the last hour's counts
// costs nothing worth a database round-trip per request.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://txtubyeityavfihabmma.supabase.co';
// The anon key is the app's PUBLIC key (it ships in the bundle); it only lets the server ask
// Supabase "whose token is this?", which is exactly what it's for. Override on the host if it rotates.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4dHVieWVpdHlhdmZpaGFibW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTQyMzgsImV4cCI6MjEwMjA3MDIzOH0.rYX72kpZmHamy4Ps_5MMLReMSo8aKQPWL2lG-eN1HYg';

// AI calls per identity. A heavy real user logs maybe 15 meals a day; 60 is far beyond that and
// still caps a leaked secret at a few dollars a day instead of an open tab.
const HOURLY = Number(process.env.AI_HOURLY_LIMIT || 25);
const DAILY = Number(process.env.AI_DAILY_LIMIT || 60);
// Identities without a verified user get a tighter ceiling: they are a race on first launch, or
// someone who chose not to send a token.
const ANON_HOURLY = Number(process.env.AI_ANON_HOURLY_LIMIT || 10);
const ANON_DAILY = Number(process.env.AI_ANON_DAILY_LIMIT || 20);

// Helper calls — the small, cheap model calls a grocery scan makes AFTER the photo is read (/classify,
// /swap-ideas). Metered in their own bucket: counted with the photo reads, one grocery scan cost up to
// three calls, so a shopper was out of scans after eight new products in an hour. They still have a
// ceiling, because they still cost money.
const HELPER_HOURLY = Number(process.env.AI_HELPER_HOURLY_LIMIT || 60);
const HELPER_DAILY = Number(process.env.AI_HELPER_DAILY_LIMIT || 200);
const HELPER_ANON_HOURLY = Number(process.env.AI_HELPER_ANON_HOURLY_LIMIT || 30);
const HELPER_ANON_DAILY = Number(process.env.AI_HELPER_ANON_DAILY_LIMIT || 80);

// Plain request ceilings. Per IP it has to be generous: a mobile carrier puts many phones behind one
// address, and one grocery scan makes a dozen requests (read, classify, ideas, then a food lookup per
// ingredient to price them). Per identity — known once the caller is identified — it can be tighter.
const IP_MAX_15M = Number(process.env.IP_LIMIT_15M || 1500);
// AI calls per IP across ALL identities. Anonymous Supabase accounts are free to mint, so a per-user
// allowance alone lets a script rotate accounts; this caps what one address can spend in an hour.
// Generous enough for many real phones behind one carrier address.
const IP_AI_HOURLY = Number(process.env.IP_AI_HOURLY_LIMIT || 200);
const IDENTITY_MAX_15M = Number(process.env.IDENTITY_LIMIT_15M || 400);

/* ── Token verification, cached ──────────────────────────────────────────── */
const tokenCache = new Map();          // token → { uid, until }
const TOKEN_TTL = 10 * 60 * 1000;

async function verifySupabaseToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.uid;
  if (!SUPABASE_ANON_KEY) return null;   // can't verify — treat as anonymous
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const u = await r.json();
    const uid = u && typeof u.id === 'string' ? u.id : null;
    if (uid) {
      tokenCache.set(token, { uid, until: Date.now() + TOKEN_TTL });
      if (tokenCache.size > 5000) tokenCache.delete(tokenCache.keys().next().value);
    }
    return uid;
  } catch { return null; }
}

/** Attach req.identity = { key, verified } — never throws, never blocks. */
async function identify(req, _res, next) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let uid = token ? await verifySupabaseToken(token) : null;
  if (uid) { req.identity = { key: `u:${uid}`, verified: true }; return next(); }
  req.identity = { key: `ip:${clientIp(req)}`, verified: false };
  next();
}

// The caller's real address. Render is fronted by Cloudflare (responses carry cf-ray), and Cloudflare
// OVERWRITES cf-connecting-ip with the address that actually connected — a client can't forge it.
// The FIRST x-forwarded-for entry, which this used before, is whatever the client chose to send, so
// a spoofed header gave every request a fresh "IP" and a fresh limit.
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - 1] || req.ip || req.socket?.remoteAddress || 'unknown';
}

/* ── Rolling counters ────────────────────────────────────────────────────── */
const hits = new Map();                // key → number[] of timestamps (ms)
function count(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, arr);
  return arr;
}
function record(key) { const arr = hits.get(key) || []; arr.push(Date.now()); hits.set(key, arr); }
// Sweep idle keys so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) { const keep = arr.filter((t) => now - t < 24 * 3600 * 1000); if (keep.length) hits.set(k, keep); else hits.delete(k); }
}, 15 * 60 * 1000).unref?.();

/** Meter an AI route in a bucket: 429 with a Retry-After when the caller is over that allowance. */
function meter(bucket, limits) {
  return (req, res, next) => {
    const id = req.identity || { key: `ip:${clientIp(req)}`, verified: false };
    const hourly = id.verified ? limits.hourly : limits.anonHourly;
    const daily = id.verified ? limits.daily : limits.anonDaily;
    const k = `${id.key}${bucket}`;
    const h = count(`${k}:h`, 3600 * 1000).length;
    const d = count(`${k}:d`, 24 * 3600 * 1000).length;
    const ipKey = `ipai:${clientIp(req)}${bucket}`;
    const ipH = limits.ipHourly ? count(ipKey, 3600 * 1000).length : 0;
    if (h >= hourly || d >= daily || (limits.ipHourly && ipH >= limits.ipHourly)) {
      res.set('Retry-After', String(h >= hourly || ipH >= (limits.ipHourly || Infinity) ? 3600 : 6 * 3600));
      return res.status(429).json({ error: 'quota', message: 'You have hit the limit for now. Please try again later.' });
    }
    record(`${k}:h`); record(`${k}:d`);
    if (limits.ipHourly) record(ipKey);
    next();
  };
}
/** Photo reads, the coach, menus — the main AI allowance. (Bucket '' keeps the original counter keys.) */
const aiQuota = meter('', { hourly: HOURLY, daily: DAILY, anonHourly: ANON_HOURLY, anonDaily: ANON_DAILY, ipHourly: IP_AI_HOURLY });
/** The cheap follow-up calls a grocery scan makes. Separate so they can't use up photo scans. */
const helperQuota = meter(':helper', { hourly: HELPER_HOURLY, daily: HELPER_DAILY, anonHourly: HELPER_ANON_HOURLY, anonDaily: HELPER_ANON_DAILY, ipHourly: IP_AI_HOURLY * 3 });

/** Plain per-IP request ceiling for everything, so a script can't hammer even cheap routes. */
function ipLimit({ windowMs = 15 * 60 * 1000, max = IP_MAX_15M } = {}) {
  return (req, res, next) => {
    if (req.path === '/health') return next();
    const key = `ipall:${clientIp(req)}`;
    if (count(key, windowMs).length >= max) { res.set('Retry-After', String(Math.ceil(windowMs / 1000))); return res.status(429).json({ error: 'rate_limited' }); }
    record(key);
    next();
  };
}

/** Per-identity request ceiling for every route, applied after identify(). */
function identityLimit({ windowMs = 15 * 60 * 1000, max = IDENTITY_MAX_15M } = {}) {
  return (req, res, next) => {
    if (req.path === '/health' || !req.identity) return next();
    const key = `idall:${req.identity.key}`;
    if (count(key, windowMs).length >= max) { res.set('Retry-After', String(Math.ceil(windowMs / 1000))); return res.status(429).json({ error: 'rate_limited' }); }
    record(key);
    next();
  };
}

module.exports = { identify, aiQuota, helperQuota, ipLimit, identityLimit };
