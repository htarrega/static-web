# ai-and-narrative — design and decisions

Website for the workshop **«Imaginación, escritura e IA» / «AI & narrative»**
(Bibliocafé, 4 sessions, November 2026), served at
`https://htarrega.me/ai-and-narrative/` behind one or more passwords.

This document records **what** was built, **why**, and the alternatives that
were rejected, so any future change starts from the same premises.

Status: **setup phase.** Content and design approved; the Worker is written
and tested locally; not deployed yet (see "Pending").

---

## 1. Requirements

| Requirement | Source |
|---|---|
| Host on my domain the same page as the claude.ai artifact (`9ZCRSetasGu2DhtX5GuTRg`) | Initial request |
| **Static** site | Initial request; consistent with the rest of htarrega.me |
| **Restrict access** to workshop attendees | Initial request |
| 4 sessions, one page each | There will be 4 sessions |
| **Spanish and English** | Request; translate everything, prompts included |
| When the **password changes**, holders of the old one **lose access** | Explicit question; decided the mechanism |
| Edit and try things locally before encrypting/publishing anything | Agreed order: decide → localhost → approve → setup |
| Review on a branch; **local commits only, never push** | Explicit instruction |
| Keep everything **in the static-web repo**, not a separate one | Explicit preference |
| **Several passwords valid at once**, and an easy way to set them and **choose how long they last** | Explicit question |

Audience: attendees of a library workshop, mostly **non-technical** (hence the
large type, huge buttons, "tap Aa"…). Every bit of access friction counts.

## 2. Constraints discovered

- **The `htarrega/static-web` repo is public.** Anything committed in plaintext
  is readable on github.com even if the site asks for a password. This rules
  out any approach that puts unencrypted content in the repo.
- htarrega.me is served by **GitHub Pages** and **`master` is the deploy
  branch** (push = live).
- DNS is on **Cloudflare with the proxy on** (orange cloud): Cloudflare logic
  (Workers, Access) can sit in front of a single path without touching the
  rest of the site.
- The original artifact **uses no Claude runtime capabilities**: it is
  self-contained HTML + CSS + JS, with `localStorage` for progress and font
  size. Portable as is.

## 3. Decision: access mechanism → **Cloudflare Worker with a server-side password**

### Options evaluated

| | Attendee friction | Revoke on password change | Offline brute force | Content on GitHub |
|---|---|---|---|---|
| A. Cloudflare Access (email OTP) | Medium (email + code) | Yes, per person | No | None |
| B. StatiCrypt (encrypted HTML in the repo) | Low | **Going forward only** | **Yes** | Encrypted, forever |
| C. Secret URL + noindex | None | No | — | — |
| **D. Worker + shared password + cookie** | **Low** | **Yes, immediately** | **No** | **None** |

### Why not StatiCrypt (initially the recommendation)

Researched (official README and FAQ, v3.5.4): AES-256 + PBKDF2-SHA256 with
600k iterations (the OWASP figure); "remember me" stores the salted hash in
`localStorage`; the salt is pinned in `.staticrypt.json`. It is solid **if the
password is long (16+ characters)**, but:

1. **No real revocation.** Old encrypted versions stay in the public git
   history; anyone with the old password can still open them. Rewriting
   history is not enough (GitHub serves orphaned commits by SHA, forks,
   caches). This conflicts with the requirement in §1.
2. The encrypted file is public → unlimited offline dictionary attacks.
3. The "magic link" carries the hash, which is equivalent to the key.

### Why not Cloudflare Access

It meets every requirement and can even revoke per person, but each attendee
has to receive an emailed code to get in: too much friction for this
audience, plus an email list to maintain. It stays as plan B if individual
control is ever needed.

### Why the Worker

- The HTML **never reaches the browser** without the right password → nothing
  to attack offline.
- The session cookie is signed with the password's hash (HMAC) → **changing
  or removing a password invalidates its sessions at once**.
- What gets served is uploaded with `wrangler deploy`, independent of GitHub
  Pages. What sits in git is encrypted with git-crypt (§3b), so the public
  repo and its history never expose the content.
- One password + "remember me" ≈ StatiCrypt's friction.
- Free (Workers free tier: 100k requests/day). wrangler is already used in the
  repo (R2).
- Limit: nobody can stop someone who already got in from saving the page.
  Accepted.

## 3b. Decision: source lives in static-web, encrypted with **git-crypt**

The author prefers a single repo. The pages can't go in plaintext (public
repo), so:

| Option | Verdict |
|---|---|
| **git-crypt in static-web** | **Chosen.** One repo, history and an off-machine copy on GitHub. |
| Separate local-only git (what we had first) | Rejected: no backup, separate repo. |
| Make static-web private | Rejected: GitHub Pages on a private repo needs a paid plan, and the rest of the site is public on purpose. |

How it works and why it is safe:

- `ai-and-narrative/.gitattributes` marks `site/**` with `filter=git-crypt`.
  Files are plaintext in the working tree and AES-256 encrypted in every
  commit, transparently on `git add`/checkout.
- The key is a **random 256-bit key**, not a password, so the ciphertext in
  the public history can't be brute-forced. This is the difference from
  StatiCrypt, where the public ciphertext was protected only by the site
  password.
- Site access and repo secrecy are **decoupled**: the git-crypt key never
  changes; site passwords (Worker secret) rotate freely and revoke sessions
  on their own.
- Plaintext on purpose: `worker.js`, `wrangler.jsonc`, `DESIGN.md`,
  `.gitattributes`. They hold no secrets (the password is a Cloudflare
  secret).
- GitHub Pages never serves the encrypted files: the Worker route covers the
  whole `/ai-and-narrative*` path.

⚠️ **The key is the only way to read the content.** Exported to
`~/ai-and-narrative.git-crypt.key` (mode 600). Keep a copy in a password
manager. On a fresh clone: `git-crypt unlock <keyfile>`.

Leaked metadata (accepted): file names, sizes and commit dates.

## 4. Content and structure decisions

### File layout

```
ai-and-narrative/          (in static-web)
  site/                    everything served; encrypted in git (git-crypt)
    index.html             bilingual landing: 4 sessions + ES/EN switch
    shared.css             artifact styles + additions (marked at the end)
    shared.js              shared logic for the session pages
    es/1.html  en/1.html   session 1 (the rest: es/N.html, en/N.html)
  worker.js                access gate + password screen (plaintext)
  wrangler.jsonc           Worker config: route, assets dir (plaintext)
  .gitattributes           git-crypt rule for site/**
  access.mjs               password manager CLI (plaintext)
  access.json              password list, hashes only (git-crypt, created by access.mjs)
  .dev.vars                local copy of the list for wrangler dev (gitignored)
  DESIGN.md                this document
```

- **Only `site/` is uploaded** as assets, so `DESIGN.md`, the Worker source and
  `.dev.vars` can never be served.

- **One folder per language (`/es/`, `/en/`)**: the recommended practice for
  multilingual sites (stable structure, one URL per language). Short URLs
  (`es/1.html`) because nobody types them.
- **Shared CSS and JS**, pulled out of the artifact, so ~25 KB isn't repeated
  per page and fixes happen once. With the Worker everything is protected, so
  splitting files exposes nothing (with StatiCrypt it would have: it only
  encrypts the HTML).
- **Section ids (`#contexto`, `#reglas`…) are the same in both languages**, in
  Spanish. That way the ES/EN switch lands you on the same section.
- `shared.js` builds the tiles, headers and pager **from the HTML** (section
  order in the DOM, `data-title`, `data-desc`). Adding a session = copy a page
  and change its content, no JS changes. UI strings live in a per-language
  dictionary `T`.

### Languages

- **Everything is translated**, prompts included (author's decision).
- **Workshop name**: ES «[imaginación, escritura e ia]», EN «[ai & narrative]»
  (same as the URL).
- **Visible switch on every page**, with ES/EN codes; the active language is
  marked.
- **No automatic language redirect** (recommended practice). The landing page
  picks the saved language or, failing that, the browser's, without
  redirecting: it only swaps the text at the same URL.
- Correct `lang` on every page (screen readers, hyphenation). `hreflang` in
  `<link rel="alternate">` only as a hint; no SEO value since the content is
  private.

### `localStorage`

Every key is prefixed `ain-` so it can't clash with the rest of htarrega.me
(same origin):

- `ain-fs` — font size, shared across the whole workshop.
- `ain-lang` — preferred language.
- `ain-s<N>-seen-<section>`, `ain-s<N>-hw-<id>` — progress and homework, **per
  session and shared across languages** (switching language keeps the ticks).

The original artifact used unprefixed keys (`fs`, `hw1`, `seen-reglas`); with
4 sessions on one domain they would have collided.

### Landing page

- Sessions 2–4 as "Coming soon" tiles (grey, dashed border, no link).
- **Not linked from htarrega.me**: reached by URL, magic link or QR code.

### Indexing

- `<meta name="robots" content="noindex, nofollow">` on every page.
- The path is **not** added to `robots.txt`: if crawling is blocked, Google
  never reads the `noindex` and may list the URL anyway. (With the Worker, a
  crawler would only see the password screen.)

### Visual design

Kept from the artifact (neo-brutalist: black borders, hard shadows,
yellow/red/blue/green, Archivo Black + Atkinson Hyperlegible + Space Mono,
20 px base size). Atkinson Hyperlegible was chosen for low-vision legibility:
don't swap it lightly. The additions (language switch, "Coming soon" tiles)
reuse the same tokens.

#### Alignment with neubrutalism.com (Nov 2026)

Changes made to match the reference's grammar:

- **Square corners:** `--r` 3px → 0. The reference's one non-negotiable token.
- **Three shadow sizes:** `--sh-sm` 3px (was 2px), `--sh` 5px, new `--sh-lg` 8px,
  all drawn in `var(--ink)` instead of a hard-coded `#000`. Static panels (card, note, how-to,
  rule, step, idea, prompt box) drop to `--sh-sm`. Only things you can press
  keep the 5px shadow, so a raised block always means "tap me". The reference
  warns that hierarchy collapses when everything gets the same shadow. It
  also means non-technical visitors are less likely to try tapping blocks
  that don't do anything.
- **Hover lifts, press sinks:** `.press:hover` now moves up-left with
  `--sh-lg` (it used to sink). `:active` still sinks fully. Hover only applies on
  `(hover:hover)` devices, so a tap on a phone doesn't leave a block stuck in
  the hover state.
- **Overlays use the big shadow:** the font-size panel and the toast.
- **Square checkboxes:** the homework checkboxes are now 34px black-bordered
  squares with a thick black tick, not the browser's rounded grey ones. In
  forced-colours mode they fall back to the native checkbox.
- **"Coming soon" tiles:** solid border, no shadow (the reference's
  "flat card") instead of a dashed border. A dashed line was a second border
  style. The grey fill, missing shadow and "Coming soon" text still mark them
  as unavailable without relying on colour alone.

Deliberate deviations (accessibility wins over the reference):

- **Body font Atkinson Hyperlegible at 20px** (the reference uses Inter at 18px),
  chosen for low vision.
- **Focus ring 4px blue** (the reference uses 3px). Easier to see.
- **Tap targets ≥ 48px** (the reference's small buttons are around 40px).
- **More saturated palette and warmer background kept**
  (`#F5F0E6`, Material-style accents rather than the reference's pastels).
  Black text passes AA on every accent, and the palette is part of the
  artifact's identity.
- **Headings stay Archivo Black, uppercase.** The reference uses mixed-case
  Space Grotesk for headings. That might read a little better, but it's a
  bigger identity change, so it's left for later.
- **Press offset 5px, not 2px:** the block lands exactly on its shadow. That
  gives clearer feedback for people unsure whether their tap registered.
- **No custom cursor, marquee or rotated blocks:** decorative motion and
  odd cursors are left out for this audience.

## 5. Worker behaviour (`worker.js`)

Every request under `/ai-and-narrative/` goes through the Worker first
(`run_worker_first`):

| Request | Response |
|---|---|
| `/ai-and-narrative` | 301 to `/ai-and-narrative/` |
| No valid cookie | Bilingual password screen (same neo-brutalist style, inline CSS because `shared.css` is behind the gate) |
| `POST /login`, any active password | Sets cookie, 303 back to the page you wanted |
| `POST /login`, wrong password | Screen with error, 401 |
| `?k=<magic>` | Sets cookie, 303 to the same URL without `k` |
| `/logout` | Clears cookie, back to the screen |
| Valid cookie | File from `site/` (`/` → `index.html`); 404 if missing |

Decisions:

- **Several named passwords at once** (asked by the author): e.g. one per
  group, or the old and new one overlapping for a few days during a change.
  Each has its own **session length** (`sessionDays`, how long a device stays
  logged in; default 120 = the whole workshop) and an optional **last valid
  day** (`until`; sessions never outlive it).
- They live in **one Worker secret, `ACCESS`**: a JSON list of
  `{name, salt, hash = sha256(salt + password), sessionDays, until}`. Only
  hashes, never plaintext. One secret instead of one per password because
  secrets are write-only: the tool keeps the list locally and re-uploads it
  whole.
- **Cookie = `name.exp.HMAC(hash, "session|name|exp")`.** Stateless (no KV/DB).
  Changing a password changes its hash and removing it drops the entry, so
  that password's sessions and magic link die immediately while the other
  passwords keep working. Editing only the durations does not log anyone out.
- Magic link key = `name.HMAC(hash, "magic|name")`.
- Plain SHA-256 (not PBKDF2) for the stored hash: the list is itself a secret,
  and the Workers free plan allows ~10 ms CPU per request. Passwords must
  still be 12+ characters (enforced by the tool).
- Cookie flags `HttpOnly; Secure; SameSite=Lax; Path=/ai-and-narrative`.
- Comparisons are constant-time (`crypto.subtle.timingSafeEqual` over SHA-256
  digests).
- The `next` redirect only accepts paths under `/ai-and-narrative/` (no open
  redirect).
- Every response: `Cache-Control: private, no-store` (Cloudflare's cache must
  never hand protected HTML to someone else), `X-Robots-Tag: noindex`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `nosniff`.
- `html_handling: "none"`: assets are served exactly as named. The default
  rewrites `.html` URLs with redirects that would drop the
  `/ai-and-narrative` prefix.

Tested locally with `wrangler dev` (21 Nov 2026): redirect, login screen
without cookie (including for `shared.css`), wrong password → 401, right
password → content, open-redirect attempt neutralised, forged cookie → screen,
missing file / `DESIGN.md` / `worker.js` → 404, logout, magic link, and
**rotation: an existing session is rejected after the password changes**.
Re-tested with the multi-password model: two passwords valid at once with 30-
and 2-day sessions (cookie `Max-Age` matches), a password past its `until`
rejected, changing one password logs out only its sessions and kills its
magic link, removing one logs out its sessions.

## 6. Workflow

1. Edit in `ai-and-narrative/site/` (plaintext locally).
2. Try it locally. Content only: `python3 -m http.server 8765 --bind
   127.0.0.1` from the repo root → `http://127.0.0.1:8765/ai-and-narrative/site/`.
   With the gate: `wrangler dev --port 8787 --local` in `ai-and-narrative/` →
   `http://127.0.0.1:8787/ai-and-narrative/` (create a test password with
   `./access.mjs add test --local`; **wrangler does not reload `.dev.vars`,
   restart it after changing it**).
3. Commit in static-web as usual; git-crypt encrypts `site/` on its own. Check
   with `git-crypt status ai-and-narrative`.
4. Publish content: `wrangler deploy` in `ai-and-narrative/`. (Pushing to
   GitHub does **not** publish the workshop; it only backs it up encrypted.)

### Managing passwords: `./access.mjs` (in `ai-and-narrative/`, your own terminal)

```
./access.mjs list                                   what exists, durations, expired or not
./access.mjs add bibliocafe --days 120 --until 2027-03-01
                                                    create (asks the password twice, hidden)
./access.mjs add bibliocafe                         change its password → its sessions die
./access.mjs edit bibliocafe --days 30 --until none change durations only
./access.mjs remove bibliocafe                      delete → its sessions die
./access.mjs link bibliocafe                        magic link for the QR code
```

Every change uploads the list to Cloudflare (`wrangler secret put ACCESS`)
and is live at once; `--local` only updates `.dev.vars` for `wrangler dev`.
The tool keeps `access.json` (hashes only, encrypted in git by git-crypt) as
the source of truth: never edit the secret in the dashboard, the next change
would overwrite it.

## 7. Pending

- `wrangler login` (author, interactive).
- Create the real password(s) with `./access.mjs add …` (author, in their own
  terminal, so they never pass through the assistant).
- `wrangler deploy` and production checks with curl.
- Cloudflare rate-limiting rule on `POST /ai-and-narrative/login` (dashboard).
- Magic link + QR code for class.
- Check the exact label of Claude's privacy setting in the English
  translation ("Help improve Claude"); it depends on the real UI.

## 8. Sources

- StatiCrypt README/FAQ — https://github.com/robinmoisson/staticrypt
- StatiCrypt issue #159 (iterations) — https://github.com/robinmoisson/staticrypt/issues/159
- OWASP Password Storage Cheat Sheet (PBKDF2) — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2
- Cloudflare Pages + Access — https://revdoku.com/blog/how-to-password-protect-a-cloudflare-pages-site/
- International URL structure — https://specification.website/spec/i18n/international-url-structure/
- Hreflang / multilingual — https://www.searchenginejournal.com/hreflang-multilingual-website/260855/
