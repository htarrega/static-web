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
async function recordFailure(env, req, n) {
  try { if (env.RL) await env.RL.put(failKey(req), String(n + 1), { expirationTtl: FAIL_WINDOW }); } catch {}
}

/* Hash and compare against every entry (no early exit) so timing doesn't
   reveal which one matched. */
async function matchPassword(list, pw) {
  const now = nowSec();
  let found = null;
  for (const e of list) {
    const ok = await safeEqual(await sha256Hex(e.salt + pw), e.hash);
    if (ok && active(e, now) && !found) found = e;
  }
  return found;
}

// Signature labels are part of the cookie/magic-link format: changing them
// logs everyone out and breaks links already handed out (access.mjs signs "magic|" too).
const sessionSig = (e, exp) => hmacHex(e.hash, `session|${e.name}|${exp}`);

async function issueCookie(e) {
  const now = nowSec();
  const exp = Math.min(now + Math.round((Number(e.sessionDays) || 120) * DAY), untilEpoch(e));
  return sessionCookie(`${e.name}.${exp}.${await sessionSig(e, exp)}`, exp - now);
}

async function validCookie(list, value) {
  if (!value) return false;
  const [name, expStr, sig] = value.split('.');
  const exp = Number(expStr);
  const now = nowSec();
  const e = list.find(x => x.name === name);
  if (!e || !sig || !Number.isFinite(exp) || exp <= now || !active(e, now)) return false;
  return safeEqual(sig, await sessionSig(e, exp));
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
async function attempt(env, req, next, check) {
  const fails = await failures(env, req);
  if (fails >= MAX_FAILS) return loginPage(next, 'locked');
  const e = await check();
  if (e) return redirect(next, await issueCookie(e));
  await recordFailure(env, req, fails);
  return loginPage(next, 'bad');
}

export default {
  async fetch(req, env) {
    return harden(await handle(req, env));
  },
};

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === PREFIX) return Response.redirect(url.origin + PREFIX + '/' + url.search, 301);
  if (!path.startsWith(PREFIX + '/')) return new Response('Not found', { status: 404 });
  const list = loadAccess(env);
  if (!list.length) return new Response('No passwords configured (ACCESS secret)', { status: 500 });

  const sub = path.slice(PREFIX.length); // always starts with "/"

  if (sub === '/login' && req.method === 'POST') {
    const form = await req.formData();
    const next = safeNext(String(form.get('next') || ''));
    return attempt(env, req, next, () => matchPassword(list, String(form.get('password') || '')));
  }

  if (sub === '/logout') return redirect(PREFIX + '/', sessionCookie('', 0));

  // Magic link (?k=name.sig): set the cookie, then drop the key from the URL.
  const k = url.searchParams.get('k');
  if (k !== null) {
    url.searchParams.delete('k');
    return attempt(env, req, safeNext(url.pathname + url.search), () => matchMagic(list, k));
  }

  if (!(await validCookie(list, getCookie(req, COOKIE)))) {
    return loginPage(safeNext(path + url.search), null);
  }

  // Authorised: map /ai-and-narrative/<x> to site/<x>.
  const assetUrl = new URL(url);
  assetUrl.pathname = sub.endsWith('/') ? sub + 'index.html' : sub;
  assetUrl.search = '';
  return env.ASSETS.fetch(new Request(assetUrl, req));
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
