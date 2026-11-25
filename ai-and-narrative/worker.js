/* Access gate for htarrega.me/ai-and-narrative/*
   Rationale and design decisions: see DESIGN.md.

   Several named passwords can be valid at once. They live in the ACCESS
   secret as a JSON array managed by ./access.mjs (never edit it by hand):
     [{ "name": "bibliocafe", "salt": "<hex>", "hash": "<hex sha256(salt+pw)>",
        "sessionDays": 120, "until": "2027-03-01" | null }]

   - Cookie = "<name>.<exp>.<sig>", sig = HMAC(entry.hash, "session|name|exp").
     Changing a password changes its hash; removing it drops the entry. Either
     way its sessions and magic links die immediately. No storage needed.
   - sessionDays: how long a device stays logged in after typing it.
   - until: last day the password works; sessions never outlive it.
   - Pages live in ./site and are served through the ASSETS binding only after
     the cookie checks out (run_worker_first). */

const PREFIX = '/ai-and-narrative';
const COOKIE = 'ain_session';
const DAY = 86400;
// Brute-force limit: after MAX_FAILS wrong passwords/magic links from one IP,
// that IP is locked out until FAIL_WINDOW seconds pass with no new failure.
const MAX_FAILS = 30;
const FAIL_WINDOW = 3600;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/* Constant-time comparison of two strings of any length: hash both first so
   timingSafeEqual always gets equal-length buffers. */
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const nowSec = () => Math.floor(Date.now() / 1000);

/* End of the "until" day, in Europe/Madrid-ish terms: 23:59:59 UTC+1. */
function untilEpoch(e) {
  return e.until ? Math.floor(Date.parse(e.until + 'T23:59:59+01:00') / 1000) : Infinity;
}
const active = (e, now) => untilEpoch(e) > now;

function loadAccess(env) {
  try {
    const list = JSON.parse(env.ACCESS || '[]');
    return Array.isArray(list) ? list.filter(e => e && /^[a-z0-9-]+$/.test(e.name) && e.hash && e.salt) : [];
  } catch { return []; }
}

/* Counters live in KV. If KV is missing or over quota, fail open: the gate
   itself still holds, only the throttling is lost. */
const failKey = req => 'fail:' + (req.headers.get('CF-Connecting-IP') || 'local');
async function failures(env, req) {
  try { return env.RL ? parseInt((await env.RL.get(failKey(req))) || '0', 10) : 0; } catch { return 0; }
}
async function recordFailure(env, ctx, req, n) {
  try { if (env.RL) await env.RL.put(failKey(req), String(n + 1), { expirationTtl: FAIL_WINDOW }); } catch {}
  // Anonymous tag: first 3 hex of sha256(ip|day). Rotates daily, IP never stored.
  const anon = (await sha256Hex((req.headers.get('CF-Connecting-IP') || 'local') + '|' + madridDay())).slice(0, 3);
  const country = req.cf?.country || null;
  logEvent(env, ctx, { kind: 'fail', anon, country });
  if (n + 1 === MAX_FAILS) logEvent(env, ctx, { kind: 'lock', anon, country });
}

/* Hash and compare against every entry (no early exit) so timing doesn't
   reveal which one matched. */
async function matchPassword(list, pw) {
  // Mobile keyboards and copy-paste from an email often add a space at the
  // ends; passwords never have one (access.mjs refuses spaces), so also try
  // the trimmed input. Trying the raw input too keeps any older entry working.
  const tries = pw.trim() === pw ? [pw] : [pw, pw.trim()];
  const now = nowSec();
  let found = null;
  for (const e of list) {
    for (const t of tries) {
      const ok = await safeEqual(await sha256Hex(e.salt + t), e.hash);
      if (ok && active(e, now) && !found) found = e;
    }
  }
  return found;
}

// Signature labels are part of the cookie/magic-link format: changing them
// logs everyone out and breaks links already handed out (access.mjs signs "magic|" too).
const sessionSig = (e, exp) => hmacHex(e.hash, `session|${e.name}|${exp}`);

async function issueCookie(e) {
  const now = nowSec();
  const exp = Math.min(now + Math.round((Number(e.sessionDays) || 120) * DAY), untilEpoch(e));
  const value = `${e.name}.${exp}.${await sessionSig(e, exp)}`;
  return { value, header: sessionCookie(value, exp - now) };
}

/* Returns the matching entry, or null. */
async function validCookie(list, value) {
  if (!value) return null;
  const [name, expStr, sig] = value.split('.');
  const exp = Number(expStr);
  const now = nowSec();
  const e = list.find(x => x.name === name);
  if (!e || !sig || !Number.isFinite(exp) || exp <= now || !active(e, now)) return null;
  return (await safeEqual(sig, await sessionSig(e, exp))) ? e : null;
}

async function matchMagic(list, k) {
  const [name, sig] = k.split('.');
  const e = list.find(x => x.name === name);
  if (!e || !sig || !active(e, nowSec())) return null;
  return (await safeEqual(sig, await hmacHex(e.hash, `magic|${e.name}`))) ? e : null;
}

function getCookie(req, name) {
  const h = req.headers.get('Cookie') || '';
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=${PREFIX}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/* Headers on every response from this path: never cache (a shared cache must
   not hand protected HTML to someone without the cookie), never index. */
function harden(res) {
  const r = new Response(res.body, res);
  r.headers.set('Cache-Control', 'private, no-store');
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('X-Frame-Options', 'DENY');
  return r;
}

function redirect(location, cookie) {
  return new Response(null, { status: 303, headers: { Location: location, 'Set-Cookie': cookie } });
}

/* Only allow redirects back into the workshop, never to another site: a
   same-origin path under PREFIX (so never "//host" or "https://..."). */
function safeNext(next) {
  return next.startsWith(PREFIX + '/') ? next : PREFIX + '/';
}

/* Password form and magic link alike: refuse while this IP is locked out,
   otherwise log in on success or count the failure. */
async function attempt(env, ctx, req, next, method, check) {
  const fails = await failures(env, req);
  if (fails >= MAX_FAILS) return loginPage(next, 'locked');
  const e = await check();
  if (e) {
    const c = await issueCookie(e);
    logEvent(env, ctx, {
      kind: 'login', pw: e.name, method, device: await deviceId(c.value),
      dtype: deviceType(req), country: req.cf?.country || null,
    });
    return redirect(next, c.header);
  }
  await recordFailure(env, ctx, req, fails);
  return loginPage(next, 'bad');
}

/* ---- Stats (D1). Everything here fails open: the gate never depends on it. ---- */

const MADRID = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const madridDay = (ms = Date.now()) => MADRID.format(ms);
const dayMs = d => Date.parse(d + 'T12:00:00Z'); // UTC noon: immune to DST
const addDays = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);

const ownerNames = env => new Set((env.OWNER_NAMES || '').split(',').map(s => s.trim()).filter(Boolean));
const deviceId = async cookieValue => (await sha256Hex(cookieValue)).slice(0, 16);

function deviceType(req) {
  const ua = req.headers.get('User-Agent') || '';
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|Android.*Mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

const COLS = ['kind', 'pw', 'device', 'page', 'lang', 'dtype', 'method', 'country', 'anon', 'view', 'idx'];

/* Queue an event write. Owner events are never recorded. */
function logEvent(env, ctx, ev) {
  if (!env.DB || (ev.pw && ownerNames(env).has(ev.pw))) return;
  const ts = nowSec();
  ctx.waitUntil((async () => {
    try {
      await env.DB.prepare(
        `INSERT INTO events (ts, day, ${COLS.join(', ')}) VALUES (?, ?, ${COLS.map(() => '?').join(', ')})`
      ).bind(ts, madridDay(ts * 1000), ...COLS.map(c => ev[c] ?? null)).run();
    } catch {}
  })());
}

function countRequest(env, ctx) {
  if (!env.DB) return;
  ctx.waitUntil((async () => {
    try {
      await env.DB.prepare(
        'INSERT INTO daily_requests (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1'
      ).bind(madridDay()).run();
    } catch {}
  })());
}

export default {
  async fetch(req, env, ctx) {
    return harden(await handle(req, env, ctx));
  },
};

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path.startsWith(PREFIX + '/')) countRequest(env, ctx);

  if (path === PREFIX) return Response.redirect(url.origin + PREFIX + '/' + url.search, 301);
  if (!path.startsWith(PREFIX + '/')) return new Response('Not found', { status: 404 });
  const list = loadAccess(env);
  if (!list.length) return new Response('No passwords configured (ACCESS secret)', { status: 500 });

  const sub = path.slice(PREFIX.length); // always starts with "/"

  if (sub === '/login' && req.method === 'POST') {
    const form = await req.formData();
    const next = safeNext(String(form.get('next') || ''));
    return attempt(env, ctx, req, next, 'typed', () => matchPassword(list, String(form.get('password') || '')));
  }

  if (sub === '/logout') return redirect(PREFIX + '/', sessionCookie('', 0));

  // Magic link (?k=name.sig): set the cookie, then drop the key from the URL.
  const k = url.searchParams.get('k');
  if (k !== null) {
    url.searchParams.delete('k');
    return attempt(env, ctx, req, safeNext(url.pathname + url.search), 'magic', () => matchMagic(list, k));
  }

  const cookieVal = getCookie(req, COOKIE);
  const who = await validCookie(list, cookieVal);
  if (!who) {
    if (sub === '/_r') return new Response('Unauthorized', { status: 401 });
    return loginPage(safeNext(path + url.search), null);
  }
  const isOwner = ownerNames(env).has(who.name);
  const device = await deviceId(cookieVal);
  const dtype = deviceType(req);
  const country = req.cf?.country || null;

  // Section-open beacon.
  if (sub === '/_r') {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let b;
    try { b = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
    if (!b || typeof b.page !== 'string' || !/^(index|\d{1,2})$/.test(b.page) || typeof b.view !== 'string' || !/^[a-z0-9-]{1,30}$/.test(b.view) || !Number.isInteger(b.idx) || b.idx < 0 || b.idx > 50) {
      return new Response('Bad request', { status: 400 });
    }
    logEvent(env, ctx, { kind: 'read', pw: who.name, device, page: b.page, view: b.view, idx: b.idx, dtype, country });
    return new Response(null, { status: 204 });
  }

  // Owner-only panel. Anything that could resolve to "admin" (encoded, doubled
  // slashes, other casing) is treated as admin; non-owners just see a 404.
  let flat = sub;
  try { flat = decodeURIComponent(sub); } catch {}
  if (/admin/i.test(flat) || /admin/i.test(sub)) {
    if (!isOwner) return new Response('Not found', { status: 404 });
    if (sub === '/admin' || sub === '/admin/') {
      if (sub === '/admin') return Response.redirect(url.origin + PREFIX + '/admin/', 301);
      return env.ASSETS.fetch(new Request(new URL('/admin.html', url), { method: 'GET', headers: req.headers }));
    }
    if (sub === '/admin.html') return env.ASSETS.fetch(new Request(new URL('/admin.html', url), { method: 'GET', headers: req.headers }));
    if (sub === '/admin/data') return adminData(env, url, list);
    return new Response('Not found', { status: 404 });
  }

  // Authorised: map /ai-and-narrative/<x> to site/<x>.
  const assetUrl = new URL(url);
  assetUrl.pathname = sub.endsWith('/') ? sub + 'index.html' : sub;
  assetUrl.search = '';
  const res = await env.ASSETS.fetch(new Request(assetUrl, req));

  if (req.method === 'GET' && res.status === 200) {
    const m = assetUrl.pathname.match(/^\/(?:index\.html|(es|en)\/(\d{1,2})\.html)$/);
    if (m) {
      logEvent(env, ctx, {
        kind: 'view', pw: who.name, device, page: m[2] || 'index', lang: m[1] || null, dtype, country,
      });
    }
  }
  return res;
}

/* ---- Owner stats API ---- */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function sessionsConfig(env) {
  try {
    const l = JSON.parse(env.SESSIONS || '[]');
    return (Array.isArray(l) ? l : [])
      .filter(s => s && Number.isInteger(s.id) && /^\d{4}-\d{2}-\d{2}$/.test(s.published))
      .map(s => ({ id: s.id, published: s.published }))
      .sort((a, b) => a.id - b.id);
  } catch { return []; }
}

async function adminData(env, url, list) {
  const range = ['7', '30', 'all'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '7';
  const today = madridDay();
  const sessions = sessionsConfig(env);
  const passwords = list.map(e => ({
    name: e.name,
    sessionDays: Number(e.sessionDays) || 120,
    until: e.until || null,
    daysLeft: e.until ? daysBetween(today, e.until) : null,
  }));
  const out = {
    generatedAt: new Date().toISOString(), today, range, rangeStart: today, sessions,
    kpi: {
      devicesWeek: 0, devicesPrevWeek: 0, devicesEver: 0, lastSession: null,
      failures7d: 0, lockouts7d: 0, lockoutsPrev7d: 0,
      requestsToday: 0, requestsYesterday: 0, requestLimit: 100000,
    },
    daily: [],
    sessionReads: sessions.map(s => ({ id: s.id, devices: 0, es: 0, en: 0 })),
    access: { byPassword: [], failures: 0, lockouts: [] },
    deviceTypes: { mobile: 0, tablet: 0, desktop: 0 },
    reading: sessions.map(s => ({ id: s.id, readers: 0, views: [] })),
    passwords,
  };
  if (!env.DB) { out.dbMissing = true; return json(out); }

  const q = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
  const one = async (sql, ...args) => Object.values((await q(sql, ...args))[0] || { v: 0 })[0] || 0;
  try {
    const first = await one('SELECT MIN(day) FROM events');
    const start = range === 'all' ? (first || today) : addDays(today, -(Number(range) - 1));
    out.rangeStart = start;
    const w0 = addDays(today, -6), p0 = addDays(today, -13), p1 = addDays(today, -7);
    const active = `kind IN ('view','login') AND device IS NOT NULL`;
    const dev = (a, b) => one(`SELECT COUNT(DISTINCT device) FROM events WHERE ${active} AND day BETWEEN ? AND ?`, a, b);
    const cnt = (kind, a, b) => one('SELECT COUNT(*) FROM events WHERE kind = ? AND day BETWEEN ? AND ?', kind, a, b);

    const k = out.kpi;
    k.devicesWeek = await dev(w0, today);
    k.devicesPrevWeek = await dev(p0, p1);
    k.devicesEver = await one(`SELECT COUNT(DISTINCT device) FROM events WHERE ${active}`);
    k.failures7d = await cnt('fail', w0, today);
    k.lockouts7d = await cnt('lock', w0, today);
    k.lockoutsPrev7d = await cnt('lock', p0, p1);
    const reqs = await q('SELECT day, n FROM daily_requests WHERE day IN (?, ?)', today, addDays(today, -1));
    for (const r of reqs) { if (r.day === today) k.requestsToday = r.n; else k.requestsYesterday = r.n; }

    // Distinct viewing devices per page, and per page+lang (all time).
    const views = (a, b) => q(`SELECT page, lang, COUNT(DISTINCT device) AS n FROM events WHERE kind = 'view' AND day BETWEEN ? AND ? GROUP BY page, lang`, a, b);
    const allViews = await views('0000-00-00', '9999-99-99');
    const pageDevices = id => one(`SELECT COUNT(DISTINCT device) FROM events WHERE kind = 'view' AND page = ?`, String(id));
    for (const sr of out.sessionReads) {
      sr.devices = await pageDevices(sr.id);
      for (const v of allViews) {
        if (v.page === String(sr.id) && (v.lang === 'es' || v.lang === 'en')) sr[v.lang] = v.n;
      }
    }

    const published = sessions.filter(s => s.published <= today);
    const last = published[published.length - 1];
    if (last) {
      const prev = published[published.length - 2] || null;
      const age = daysBetween(last.published, today);
      k.lastSession = {
        id: last.id, devices: await pageDevices(last.id), ofDevicesEver: k.devicesEver,
        prevId: prev ? prev.id : null,
        prevDevicesAtSameAge: prev
          ? await one(`SELECT COUNT(DISTINCT device) FROM events WHERE kind = 'view' AND page = ? AND day <= ?`, String(prev.id), addDays(prev.published, age))
          : null,
      };
    }

    // Daily distinct devices across the range, zero-filled.
    const perDay = new Map((await q(
      `SELECT day, COUNT(DISTINCT device) AS n FROM events WHERE ${active} AND day BETWEEN ? AND ? GROUP BY day`, start, today
    )).map(r => [r.day, r.n]));
    for (let d = start; d <= today; d = addDays(d, 1)) out.daily.push({ day: d, devices: perDay.get(d) || 0 });

    out.access.byPassword = [];
    const byPw = new Map();
    for (const r of await q(`SELECT pw, method, COUNT(*) AS n FROM events WHERE kind = 'login' AND day BETWEEN ? AND ? GROUP BY pw, method`, start, today)) {
      const o = byPw.get(r.pw) || { name: r.pw, typed: 0, magic: 0 };
      if (r.method === 'typed' || r.method === 'magic') o[r.method] += r.n;
      byPw.set(r.pw, o);
    }
    out.access.byPassword = [...byPw.values()];
    out.access.failures = await cnt('fail', start, today);
    out.access.lockouts = (await q(
      `SELECT ts, country, anon FROM events WHERE kind = 'lock' AND day BETWEEN ? AND ? ORDER BY ts DESC LIMIT 20`, start, today
    )).map(r => ({ ts: r.ts, country: r.country || null, anon: r.anon }));

    for (const r of await q(
      `SELECT dtype, COUNT(*) AS n FROM (SELECT device, dtype, MAX(ts) FROM events WHERE ${active} AND dtype IS NOT NULL AND day BETWEEN ? AND ? GROUP BY device) GROUP BY dtype`, w0, today
    )) if (r.dtype in out.deviceTypes) out.deviceTypes[r.dtype] = r.n;

    const readers = await q(`SELECT page, COUNT(DISTINCT device) AS n FROM events WHERE kind = 'read' GROUP BY page`);
    const vs = await q(
      `SELECT page, view, MIN(idx) AS idx, COUNT(DISTINCT device) AS devices FROM events
       WHERE kind = 'read' AND view IS NOT NULL GROUP BY page, view ORDER BY page, MIN(idx)`
    );
    for (const rd of out.reading) {
      rd.readers = (readers.find(x => x.page === String(rd.id)) || {}).n || 0;
      rd.views = vs.filter(x => x.page === String(rd.id)).map(x => ({ view: x.view, idx: x.idx, devices: x.devices }));
    }
  } catch { out.dbMissing = true; }
  return json(out);
}

function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const LOGIN_STATES = {
  bad: { status: 401, es: 'Esa contraseña no es correcta. Prueba otra vez.', en: "That password isn't right. Try again." },
  locked: { status: 429, es: 'Demasiados intentos fallidos. Espera una hora y vuelve a probar.', en: 'Too many failed attempts. Wait an hour and try again.' },
};

/* Bilingual password screen. Self-contained: shared.css sits behind the gate,
   so the neo-brutalist tokens are repeated here. */
function loginPage(next, state) { // state: null | 'bad' | 'locked'
  const s = LOGIN_STATES[state];
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Imaginación, escritura e IA · AI &amp; narrative</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Atkinson+Hyperlegible:wght@400;700&family=Space+Mono:wght@700&display=swap" rel="stylesheet">
<script>
(function(){var l=null;try{l=localStorage.getItem('ain-lang')}catch(e){}
if(l!=='es'&&l!=='en')l='es';
document.documentElement.lang=l;})();
</script>
<style>
:root{--bg:#F5F0E6;--paper:#fff;--ink:#000;--muted:#2b2b2b;--yellow:#FFEB3B;--red:#FF5252;--blue:#2196F3;--green:#4CAF50;
--bw:3px;--sh-sm:3px 3px 0 var(--ink);--sh:5px 5px 0 var(--ink);--sh-lg:8px 8px 0 var(--ink);
--display:"Archivo Black","Arial Black",Impact,sans-serif;--body:"Atkinson Hyperlegible",Verdana,"Segoe UI",sans-serif;--mono:"Space Mono",ui-monospace,Menlo,Consolas,monospace;color-scheme:light}
*{box-sizing:border-box}
html{font-size:20px;background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.6;min-height:100vh}
:focus-visible{outline:4px solid var(--blue);outline-offset:3px}
html[lang="es"] [data-l="en"],html[lang="en"] [data-l="es"]{display:none!important}
.topbar{background:var(--yellow);border-bottom:var(--bw) solid var(--ink)}
.topbar .in{max-width:640px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{font-family:var(--mono);font-weight:700;font-size:.85rem;flex:1;min-width:180px}
.langsw{display:flex;gap:8px}
.press{border:var(--bw) solid var(--ink);box-shadow:var(--sh);transition:transform .08s,box-shadow .08s}
@media (hover:hover){.press:hover{transform:translate(-2px,-2px);box-shadow:var(--sh-lg)}}
.press:active{transform:translate(5px,5px);box-shadow:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.langsw button{min-width:56px;min-height:48px;background:var(--paper);font-family:var(--mono);font-weight:700;font-size:.8rem;cursor:pointer;color:var(--ink)}
.langsw button[aria-current="true"]{background:var(--ink);color:var(--paper);box-shadow:none;transform:none;pointer-events:none}
main{max-width:640px;margin:0 auto;padding:40px 16px 80px}
h1{font-family:var(--display);font-weight:400;font-size:2.2rem;line-height:1.05;text-transform:uppercase;margin:0 0 .5em;text-wrap:balance}
.card{background:var(--paper);border:var(--bw) solid var(--ink);box-shadow:var(--sh-sm);padding:22px 20px;margin-top:24px}
label{display:block;font-weight:700;margin-bottom:8px}
input[type=password]{width:100%;min-height:56px;font:inherit;font-size:1.1rem;padding:8px 14px;border:var(--bw) solid var(--ink);background:var(--paper);color:var(--ink);border-radius:0}
.btn{margin-top:18px;width:100%;min-height:58px;font:inherit;font-weight:700;font-size:1.05rem;background:var(--green);color:var(--ink);cursor:pointer}
.err{background:var(--red);border:var(--bw) solid var(--ink);padding:10px 14px;font-weight:700;margin:0 0 16px}
.help{color:var(--muted);font-size:.9rem;margin:16px 0 0}
@media (max-width:520px){h1{font-size:1.7rem}}
</style>
</head>
<body>
<header class="topbar"><div class="in">
  <span class="brand"><span data-l="es">[imaginación, escritura e ia]</span><span data-l="en">[ai &amp; narrative]</span></span>
  <div class="langsw" role="group" aria-label="Idioma / Language">
    <button type="button" class="press" data-set="es" lang="es">ES</button>
    <button type="button" class="press" data-set="en" lang="en">EN</button>
  </div>
</div></header>
<main>
  <h1><span data-l="es">Material del taller</span><span data-l="en">Workshop material</span></h1>
  <p><span data-l="es">Esta página es solo para quienes asisten al taller. Escribe la contraseña que os dimos en clase.</span><span data-l="en">This page is only for workshop attendees. Enter the password we gave you in class.</span></p>
  <form class="card" method="post" action="${PREFIX}/login">
    ${s ? `<p class="err" role="alert"><span data-l="es">${s.es}</span><span data-l="en">${s.en}</span></p>` : ''}
    <label for="pw"><span data-l="es">Contraseña</span><span data-l="en">Password</span></label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="btn press" type="submit"><span data-l="es">Entrar</span><span data-l="en">Enter</span></button>
    <p class="help"><span data-l="es">Solo tendrás que escribirla una vez en este dispositivo.</span><span data-l="en">You'll only need to type it once on this device.</span></p>
    <p class="help"><span data-l="es">Contamos visitas de forma anónima, sin guardar IPs ni datos personales.</span><span data-l="en">We count visits anonymously, without storing IPs or personal data.</span></p>
  </form>
</main>
<script>
(function(){var h=document.documentElement;
function apply(l){h.lang=l;try{localStorage.setItem('ain-lang',l)}catch(e){}
document.querySelectorAll('[data-set]').forEach(function(b){b.setAttribute('aria-current',b.dataset.set===l?'true':'false')})}
document.querySelectorAll('[data-set]').forEach(function(b){b.onclick=function(){apply(b.dataset.set)}});apply(h.lang);})();
</script>
</body>
</html>`;
  return new Response(html, { status: s ? s.status : 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
