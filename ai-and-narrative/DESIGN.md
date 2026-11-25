# ai-and-narrative — design and decisions

Website for the workshop **«Imaginación, escritura e IA» / «AI & narrative»**
(Bibliocafé, 4 sessions, from November 2026), served at
`https://htarrega.me/ai-and-narrative/` behind one or more passwords. Live
since 21 Nov 2026.

Records what was built, why, and the alternatives rejected.

---

## 1. Requirements and constraints

| Requirement | Note |
|---|---|
| Same content as the original claude.ai artifact (`9ZCRSetasGu2DhtX5GuTRg`), on my domain | The artifact uses no Claude runtime features (plain HTML/CSS/JS + `localStorage`), so it ports as is |
| Static site | Like the rest of htarrega.me |
| Access restricted to attendees | |
| 4 sessions, one page each | |
| Spanish and English, everything translated (prompts included) | Spanish is the default |
| Changing a password must cut off everyone who had the old one | Drove the choice of mechanism (§2) |
| Several passwords valid at once, each with its own duration, easy to manage | `access.mjs` (§7) |
| Everything in the static-web repo, not a separate one | Drove git-crypt (§3) |

Audience: library-workshop attendees, mostly non-technical, so every bit of
access friction counts (hence large type, big buttons, magic link / QR).

Constraints:

- **`htarrega/static-web` is a public repo.** Anything committed in plaintext
  is readable on GitHub regardless of any password on the site.
- htarrega.me is served by GitHub Pages; `master` is the deploy branch.
- DNS is on Cloudflare with the proxy on, so a Worker can sit in front of one
  path without touching the rest of the site.

## 2. Access mechanism: Cloudflare Worker with server-side passwords

| | Attendee friction | Revocation on password change | Offline brute force | Content on GitHub |
|---|---|---|---|---|
| A. Cloudflare Access (email OTP) | Medium (email + code) | Yes, per person | No | None |
| B. StatiCrypt (encrypted HTML in the repo) | Low | Going forward only | Yes | Encrypted, forever |
| C. Secret URL + noindex | None | No | — | — |
| **D. Worker + shared password + cookie (chosen)** | **Low** | **Yes, immediately** | **No** | **None in plaintext** |

**Why not StatiCrypt** (the first recommendation). Its crypto is sound
(v3.5.4: AES-256, PBKDF2-SHA256, 600k iterations), but old ciphertext stays
in the public history and still opens with the old password (rewriting
history doesn't help: GitHub serves commits by SHA, forks, caches), so there
is no real revocation; public ciphertext allows unlimited offline guessing;
and its magic link carries the derived key.

**Why not Cloudflare Access.** Meets every requirement and revokes per
person, but every attendee needs an emailed code and someone maintains the
email list: too much friction. Plan B if per-person control is ever needed.

**Why the Worker.** Nothing reaches the browser without a valid password, so
there is nothing to attack offline; sessions are signed with the password's
hash, so changing or removing it revokes them at once (§4); friction is
StatiCrypt-level; it fits the Workers free plan, and wrangler was already used
in the repo (R2). Accepted limit: anyone who got in can save the page.

## 3. Source lives in static-web, encrypted with git-crypt

| Option | Verdict |
|---|---|
| **git-crypt in static-web** | **Chosen.** One repo, history, and an off-machine backup on GitHub. |
| Separate local-only repo | Rejected: no backup, and a second repo. |
| Make static-web private | Rejected: GitHub Pages on a private repo needs a paid plan, and the rest of the site is public on purpose. |

- `ai-and-narrative/.gitattributes` encrypts `site/**` and `access.json`.
  Files are plaintext in the working tree and encrypted in every commit,
  transparently on add/checkout. Check with `git-crypt status ai-and-narrative`.
- The git-crypt key is a random symmetric key, not a password, so the public
  ciphertext can't be brute-forced (the difference from StatiCrypt).
- Repo secrecy and site access are decoupled: the git-crypt key never
  changes; site passwords rotate freely. Code and config stay plaintext
  (no secrets in them).
- GitHub Pages never serves the folder: the Worker route covers
  `htarrega.me/ai-and-narrative*`, and only `site/` is uploaded as assets, so
  anything outside it 404s.
- Leaked metadata (accepted): file names, sizes, commit dates.

⚠️ **The git-crypt key is the only way to read the content in git.** It is
exported to `~/ai-and-narrative.git-crypt.key` (mode 600); keep a copy in a
password manager. On a fresh clone: `git-crypt unlock <keyfile>`.

## 4. Worker behaviour (`worker.js`)

Every request on the route goes through the Worker before any asset
(`run_worker_first`).

| Request | Response |
|---|---|
| `/ai-and-narrative` | 301 to `/ai-and-narrative/` |
| No valid cookie | Password screen, 200 |
| `POST /login`, matching active password | Set cookie, 303 to the requested page |
| `POST /login`, wrong password | Screen with error, 401 |
| `?k=<magic>`, valid | Set cookie, 303 to the same URL without `k` |
| `?k=<magic>`, invalid | Screen with error, 401 |
| Locked-out IP (login or magic link) | Screen with "too many attempts", 429, even with the right password |
| `/logout` | Clear cookie, 303 to `/ai-and-narrative/` |
| Valid cookie | File from `site/` (`/` → `index.html`), 404 if missing |
| `ACCESS` secret empty or invalid | 500 |

The password screen is bilingual with inline CSS, since `shared.css` is
behind the gate.

**Password model.** Several named passwords can be valid at once (e.g. one
per group, or old and new overlapping during a change). All live in **one
Worker secret, `ACCESS`**: a JSON array of
`{name, salt, hash = sha256(salt + password), sessionDays, until}`. Only
hashes are stored. One secret rather than one per password because secrets
are write-only: the CLI keeps the list locally and re-uploads it whole.

- `sessionDays`: how long a device stays logged in (default 120).
- `until`: last valid day, ending 23:59:59 UTC+1; sessions never outlive it.

**Sessions and magic links (stateless, no storage).**

- Cookie `ain_session` = `name.exp.HMAC(hash, "session|name|exp")`, with
  `Path=/ai-and-narrative; Max-Age=<seconds to exp>; HttpOnly; Secure; SameSite=Lax`.
  `exp` = min(now + `sessionDays`, end of `until`).
- Magic link key = `name.HMAC(hash, "magic|name")`. It has no expiry of its
  own: it works while the password exists, is unchanged and is before `until`.
- Changing a password changes its hash; removing it drops the entry. Either
  way its sessions and magic link die at once; other passwords are
  unaffected. Editing durations logs nobody out (applies to new logins, but
  an earlier `until` still cuts existing sessions).

**Hashing.** Plain salted SHA-256, not PBKDF2: the list is itself a secret,
and the free plan's CPU budget per request (10 ms) leaves no room for a slow
KDF across several entries. Compensated by requiring 12+ character passwords
in the CLI (`--allow-short` exists for throwaway test entries only).
Comparisons are constant-time (`timingSafeEqual` over SHA-256 digests), and
every active entry is checked without early exit.

**Brute-force limit.** After 30 failures (wrong password or bad magic link)
from one IP, that IP is locked out. Counters are in Workers KV (binding `RL`,
key `fail:<ip>`, TTL 1 h refreshed on each counted failure), so the lockout
ends an hour after the last failure. 30 is generous on purpose: attendees
mistype, and a classroom shares one IP. If KV is unavailable the counter
fails open (the gate still holds, only throttling is lost). Done in the
Worker rather than a Cloudflare WAF rate-limiting rule because the free WAF
rule only offers a 10-second window and wrangler can't manage WAF rules.
Counting only failures keeps KV writes well under the free daily limit.

**Hardening.**

- `next` redirects only accept paths under `/ai-and-narrative/` (no open
  redirect).
- Every response: `Cache-Control: private, no-store` (Cloudflare must never
  cache protected HTML), `X-Robots-Tag: noindex, nofollow`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`.
- `html_handling: "none"`: assets are served exactly as named. The default
  rewrites `.html` URLs with redirects that drop the `/ai-and-narrative`
  prefix.

- **No spaces in passwords.** `access.mjs` trims the ends and refuses inner
  whitespace; on login the Worker tries the input as typed and trimmed,
  because mobile keyboards and copy-paste from an email often add a space.
  Trying the raw input too keeps any entry created before this rule working.

## 5. Content and structure

```
ai-and-narrative/
  site/                    everything served (git-crypt)
    index.html             bilingual landing: 4 session tiles + ES/EN switch
    shared.css             artifact styles; website additions marked at the end
    shared.js              shared logic for session pages
    es/N.html  en/N.html   one page per session and language
  worker.js                access gate + password screen
  wrangler.jsonc           route, KV binding, assets config
  access.mjs               password CLI
  access.json              password list, hashes only (git-crypt)
  .gitattributes           git-crypt rules
  .dev.vars                ACCESS for wrangler dev (gitignored)
  qr-<name>.png            QR codes from `link --qr` (gitignored)
  DESIGN.md
```

- **One folder per language**: one URL per language. Short names because
  nobody types them.
- **Shared CSS and JS** pulled out of the artifact so fixes happen once; safe
  because the Worker gates every file (StatiCrypt only encrypted HTML).
- **Section ids are the same in both languages** (Spanish: `#contexto`,
  `#reglas`…), so the language switch lands on the same section.
- `shared.js` builds tiles, headers and pager **from the HTML** (DOM order,
  `data-title`, `data-desc`). Adding a session = copy a page and change its
  content, no JS changes. UI strings are in a per-language dictionary `T`.

**Languages.**

- Workshop name: ES «[imaginación, escritura e ia]», EN «[ai & narrative]».
- Visible ES/EN switch on every page, active language marked.
- No automatic redirect by browser language. The landing page and password
  screen use the saved language, else **Spanish** (the workshop is taught in
  Spanish; the author chose this over following the browser), and swap text
  in place at the same URL.
- Correct `lang` on every page (screen readers, hyphenation). `hreflang`
  alternates are only a hint; there is no SEO value in private content.

**`localStorage`** (same origin as the rest of htarrega.me, so every key is
prefixed `ain-`; the artifact's unprefixed keys would have collided across
sessions):

- `ain-fs`: font size, shared across the workshop.
- `ain-lang`: preferred language.
- `ain-s<N>-seen-<section>`, `ain-s<N>-hw-<id>`: progress and homework, per
  session and shared across languages.

**Landing and indexing.**

- Unpublished sessions show as "Coming soon" tiles (no link).
- Not linked from htarrega.me; reached by URL, magic link or QR code.
- `<meta name="robots" content="noindex, nofollow">` on every page. The path
  is deliberately **not** in `robots.txt`: if crawling were blocked, Google
  would never see the `noindex` and could still list the URL.

## 6. Visual design and accessibility

Neo-brutalist style kept from the artifact (black borders, hard shadows,
yellow/red/blue/green, Archivo Black + Atkinson Hyperlegible + Space Mono),
then aligned with neubrutalism.com:

- Square corners (`--r: 0`).
- Three shadow sizes, all in `var(--ink)`: `--sh-sm` 3px for static panels,
  `--sh` 5px only for things you can press (so a raised block means "tap
  me"; the reference warns hierarchy collapses when everything has the same
  shadow), `--sh-lg` 8px for hover and overlays (font-size panel, toast).
- Hover lifts (up-left with `--sh-lg`), only on `(hover:hover)` devices so
  taps don't leave a block stuck; press sinks fully.
- Homework checkboxes are 34px square boxes with a thick tick; native
  checkbox under forced colours.
- "Coming soon" tiles: grey fill, solid border, no shadow. Unavailability is
  conveyed by fill, missing shadow and text, not colour alone.

Deliberate deviations from the reference (accessibility first):

| Here | Reference | Why |
|---|---|---|
| Atkinson Hyperlegible, 20px base (user-adjustable 18–28px) | Inter, 18px | Low-vision legibility; don't swap it lightly |
| 4px blue focus ring | 3px | Easier to see |
| Tap targets ≥ 48px | ~40px small buttons | Motor accessibility |
| Saturated accents, warm `#F5F0E6` background | Pastels | Black text passes AA on every accent; part of the artifact's identity |
| Headings Archivo Black, uppercase | Space Grotesk, mixed case | Bigger identity change; left for later |
| Press offset 5px (block lands on its shadow) | 2px | Clearer "your tap registered" feedback |
| No custom cursor, marquee or rotated blocks | Used | Decorative motion and odd cursors don't suit this audience |

On mobile (≤520px) the top bar wraps and "Aa" lands on the left, so the
font-size panel, anchored to its right edge, opened off-screen. It is a fixed
bottom sheet there, with 56px buttons.

## 7. Operations

### Edit, test, deploy

1. Edit in `ai-and-narrative/site/` (plaintext locally).
2. Test locally:
   - Content only: `python3 -m http.server 8765 --bind 127.0.0.1` from the
     repo root → `http://127.0.0.1:8765/ai-and-narrative/site/`.
   - With the gate: `wrangler dev --port 8787 --local` in `ai-and-narrative/`
     → `http://127.0.0.1:8787/ai-and-narrative/`. Every `access.mjs` change
     rewrites `.dev.vars`, and **wrangler dev does not reload it: restart it.**
3. Commit as usual; git-crypt encrypts on its own.
4. Publish: `wrangler deploy` in `ai-and-narrative/`. Pushing to GitHub does
   **not** publish the workshop; it only stores the encrypted backup.

### Passwords: `./access.mjs`

Run in `ai-and-narrative/`, in a real terminal (it prompts for passwords
without echo). `./access.mjs help` prints the full usage.

| Command | Effect |
|---|---|
| `list` | Entries, durations, active or expired |
| `add <name> [--days N] [--until YYYY-MM-DD]` | Create; on an existing name, change its password (its sessions and magic link die; durations kept unless given) |
| `edit <name> [--days N] [--until YYYY-MM-DD\|none]` | Change durations only |
| `remove <name>` | Delete; its sessions die |
| `link <name> [--qr]` | Print the magic link; `--qr` also writes `qr-<name>.png` and prints the QR (needs `qrencode`) |
| `push` | Re-upload the list as is (e.g. after a failed upload) |

Flags: `--local` (work on the separate test list `access.local.json` +
`.dev.vars` for `wrangler dev`; never touches `access.json` or Cloudflare),
`--allow-short` (accept < 12 characters, throwaway tests only). Defaults:
120 days, no end date.

Warnings:

- **Every change goes live in production immediately** (`wrangler secret put
  ACCESS`) unless `--local` is passed.
- The two lists are separate on purpose: test entries made with `--local`
  can never leak into production. `access.local.json` is gitignored.
- `access.json` is the source of truth. **Never edit the secret in the
  Cloudflare dashboard**: the next CLI change overwrites it.
- A QR code or magic link is equivalent to the password.

## 7b. Stats panel

An owner-only panel at `/ai-and-narrative/admin/` (data: `/admin/data?range=7|30|all`),
backed by a D1 database (`DB` binding, schema in `schema.sql`). All writes
happen in `ctx.waitUntil` and fail open: if D1 is missing or erroring, the gate
works exactly as before (and `/admin/data` answers zeros with `"dbMissing": true`).

**Recorded** (table `events`): `view` (authorised HTML page: index or session N,
language, device type, country), `login` (password name, typed or magic link),
`fail` (wrong password or link), `lock` (an IP reached MAX_FAILS; one row per
lockout), `read` (section opened, `{page, view, idx}`, sent by the page to `POST /_r`).
Table `daily_requests` counts every request per day, to compare against the
100,000/day free-plan quota.

**Privacy**: no IPs and no User-Agent are stored; device type is derived and
only the class kept. A "device" is the first 16 hex chars of sha256 of the session
cookie (no extra cookie; a new login on the same browser counts as a new
device). Failures carry only `anon` = first 3 hex of sha256(ip + day), which
rotates daily, plus the country. Typed passwords are never stored. Visits
by names in `OWNER_NAMES` (default `hugo`) are not recorded, and only they can
open the panel; anyone else gets the same 404 as a missing file. The login page
tells visitors visits are counted anonymously.

**Why D1** (decided 2026-11-25): the Worker keeps nothing between requests, so
events must be stored somewhere the panel can query. The Cloudflare dashboard
only knows total requests (no sessions, devices or passwords). The existing KV
allows ~1,000 writes/day on the free plan and can't answer "distinct devices
that opened session 2". Analytics Engine needs an API token to read and keeps
data only 3 months (the workshop runs to May 2027). D1 is free at this volume
(100,000 writes/day), queried directly from the Worker, and keeps data until
deleted.

**Setup (done 2026-11-25)**: database `ai-and-narrative-stats`, region WEUR,
id `cf54a771-23a5-4ea9-b5fb-ed3c848116bf` (in `wrangler.jsonc`). Created with
`wrangler d1 create ai-and-narrative-stats`, schema applied with
`wrangler d1 execute ai-and-narrative-stats --remote --file schema.sql`
(idempotent; re-run it after changing `schema.sql`), then `wrangler deploy`.
Data starts on that date; nothing earlier was recorded. To rebuild from
scratch: create a new database, paste its id, apply the schema, deploy.

**Querying by hand** (besides the panel):

    wrangler d1 execute ai-and-narrative-stats --remote --command "select kind, count(*) from events group by kind"
    wrangler d1 export ai-and-narrative-stats --remote --output stats.sql   # backup (gitignored)

**Deleting data**: `delete from events where day < 'YYYY-MM-DD'` with the
command above, or `wrangler d1 delete ai-and-narrative-stats` to drop the whole
database when the workshop ends (then remove the binding and redeploy; the
gate keeps working without it).

**Maintenance**: when publishing a session, add it to the `SESSIONS` var in
`wrangler.jsonc` (`{"id":N,"published":"YYYY-MM-DD"}`) and redeploy; "last
session" and per-session figures depend on it. Locally, apply the schema with
`--local` instead of `--remote`.

**Limits**: the number of students is unknown, so the panel shows absolute
counts (devices), never percentages of attendance.

## 8. Open items

- Confirm the privacy-setting labels quoted in session 1 against the live
  Claude UI (EN «Help improve Claude», ES «Ayudar a mejorar nuestros modelos
  de IA»).
- A throwaway test entry exists in the list; remove it when no longer needed
  (`./access.mjs list`).

## 9. Sources

- StatiCrypt README/FAQ — https://github.com/robinmoisson/staticrypt
- StatiCrypt issue #159 (iterations) — https://github.com/robinmoisson/staticrypt/issues/159
- OWASP Password Storage Cheat Sheet (PBKDF2) — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2
- git-crypt — https://github.com/AGWA/git-crypt
- neubrutalism.com (visual reference) — https://neubrutalism.com
- International URL structure — https://specification.website/spec/i18n/international-url-structure/
- Hreflang / multilingual — https://www.searchenginejournal.com/hreflang-multilingual-website/260855/
