---
name: add-book
description: Add or remove a book on the htarrega.me bookshelf — fetches the cover via the iTunes Search API (the iTunes Artwork Finder backend), uploads it to Cloudflare R2, edits resources/books.json, derives the spine binding, and deploys via git push. Repo-specific (static-web). Triggers in English on add / put / stick / remove / delete / drop / take off / swap a book, novel, or read, on my books, my bookshelf, my shelf, my reading list, my site, my web, my website. Triggers in Spanish (the user often writes in Spanish, with or without accents) on añade / añadir / agrega / agregar / mete / meter / pon / poner / suma / quita / quitar / elimina / eliminar / borra / borrar / saca / sacar / cambia / sustituye un libro, una novela, una lectura, on mis libros, mi estantería / estanteria, mi biblioteca, mi lista de lectura, mi web, mi página / pagina, mi sitio. A request naming a book title alongside any of these verbs is this skill, even if the word "bookshelf" or "estantería" never appears.
argument-hint: [book title, optionally author]
allowed-tools: Bash, Read, Write, Edit
---

# Add a book to the htarrega.me bookshelf

This repo (`static-web`) is a static site deployed to **GitHub Pages** (`CNAME` → htarrega.me, remote `htarrega/static-web`): pushing to `master` publishes. The bookshelf page (`bookshelf.html`) fetches `resources/books.json` and renders each entry as a 3D volume on a shelf. Covers are **not** committed to the repo — they live in the Cloudflare R2 bucket `personalweb` under the `books/` prefix and are served from `https://cv.htarrega.me/books/<slug>.webp`.

## The entry schema

Each object in `resources/books.json` has three hand-written fields and three derived ones:

| Field | Source | Purpose |
| --- | --- | --- |
| `title` | you | Caption + spine type |
| `author` | you | Caption + spine type |
| `cover` | you | `https://cv.htarrega.me/books/<slug>.webp` |
| `pages` | you (optional) | Spine **thickness**: `8 + pages * 0.062`, clamped 16–66px. Omitted or `0` falls back to a hash of the title, so a real page count is worth looking up. |
| `spineColor` | `scripts/derive-spines.py` | Cloth colour, sampled from the jacket's left strip |
| `spineInk` | `scripts/derive-spines.py` | Type colour, chosen to clear WCAG AA on the cloth |
| `ratio` | `scripts/derive-spines.py` | Jacket width/height, so the shelf can lay out before covers load |

Never hand-write the three derived fields — run the script (step 5). It is idempotent and safe to re-run over the whole file.

To **remove** a book instead, skip to [Removing a book](#removing-a-book).

Follow these steps in order.

## 1. Find the cover via the iTunes Search API

This is the same backend the iTunes Artwork Finder (bendodson.com) uses. If the user gives a Spanish (or other-language) title, use the **English/original edition title** — it is what most reliably has artwork. Query the `ebook` entity:

```bash
curl -s "https://itunes.apple.com/search?term=<title+author>&entity=ebook&limit=5" \
  -o /tmp/itunes.json
python3 -c "import json; [print(r['trackName'],'||',r['artistName'],'||',r['artworkUrl100']) for r in json.load(open('/tmp/itunes.json'))['results']]"
```

Notes:
- Pipe `curl` to a **file**, not straight into `python3 -c` — a command-rewriting proxy can mangle inline stdin and break JSON parsing.
- Pick the result whose `trackName` and `artistName` actually match the book (skip study guides, summaries, box sets). Grab its `artworkUrl100`.
- If `entity=ebook` returns nothing useful, retry with `entity=ebook` and a looser term, or `media=ebook`. As a last resort ask the user for a cover image URL.

## 2. Download a high-res cover and convert to WebP

The `artworkUrl100` ends in `/100x100bb.jpg`. Swap that segment for a large size to get full resolution (Apple preserves the real aspect ratio inside the box, so covers come out ~2:3, not square):

```bash
BASE="<artworkUrl100 without the trailing /100x100bb.jpg>"
curl -s "${BASE}/1200x1200bb.jpg" -o /tmp/cover.jpg
identify /tmp/cover.jpg          # sanity-check it's a real cover, ~2:3
```

Existing covers are ~**x600** height WebP (e.g. 406x600, ~50 KB). Match that convention:

```bash
convert /tmp/cover.jpg -resize x600 -quality 82 <slug>.webp
```

Choose `<slug>` as a short snake_case name derived from the title (e.g. `when_we_cease`, `the_road`). Keep it distinct from existing slugs in `resources/books.json`.

## 3. Upload the cover to Cloudflare R2

`wrangler` is already authenticated on this machine. R2 commands **must** use `--remote` (local is the default and will fail):

```bash
wrangler r2 object put personalweb/books/<slug>.webp --remote \
  --file <slug>.webp --content-type image/webp
```

Verify it serves before touching JSON:

```bash
curl -sI https://cv.htarrega.me/books/<slug>.webp   # expect HTTP/2 200, content-type: image/webp
```

## 4. Append the entry to books.json

Add one object to the end of the array in `resources/books.json` with the **hand-written fields only**. Keep the author style consistent with the rest of the file — plain author name, no translator (unless the book is credited to a translator, as with a few existing entries). Include `pages` (the real page count of the edition; look it up) so the spine gets a truthful thickness:

```json
  {
    "title": "When We Cease to Understand the World",
    "author": "Benjamín Labatut",
    "cover": "https://cv.htarrega.me/books/when_we_cease.webp",
    "pages": 191
  }
```

Then validate:

```bash
python3 -c "import json; d=json.load(open('resources/books.json')); print('valid,', len(d), 'books; last:', d[-1]['title'])"
```

## 5. Derive the spine binding

`spineColor`, `spineInk`, and `ratio` are baked into the JSON so the page never has to download a jacket to lay out the shelf. Fill them in by running:

```bash
python3 scripts/derive-spines.py
```

It downloads every cover (cached under `$TMPDIR/htarrega-cover-cache`), samples the left 16% of each jacket, conditions the dominant colour for a black page, picks an ink that clears 4.5:1, and rewrites `resources/books.json` in place. Expect a `N/N bindings derived from their jackets` line — if your new book reports `no image`, the R2 URL from step 3 is wrong.

Requires Pillow (`pip install pillow`). If it cannot run, the entry still renders using the hash palette in `bookshelf.html` — degraded, not broken.

## 6. Deploy

Publishing = push to `master` (GitHub Pages auto-deploys in ~1 min). Stage **only** `resources/books.json` — never `node_modules/`, `.wrangler/`, or the local `books/` scratch dir:

```bash
git add resources/books.json
git commit -m "Add '<Title>' to bookshelf"
git push origin master
```

The book is then live on `https://htarrega.me/bookshelf.html`.

## Removing a book

Delete its object from the array in `resources/books.json` — that alone takes it off the shelf. Do **not** re-run `derive-spines.py` for a removal; the remaining entries already carry their bindings.

```bash
python3 -c "import json; d=json.load(open('resources/books.json')); print('valid,', len(d), 'books')"
git add resources/books.json
git commit -m "Remove '<Title>' from bookshelf"
git push origin master
```

### The cover in R2

What happens to the jacket depends on **why** the book is leaving:

- **A substitution** — the user swaps one book for another in a single request ("quita X y mete Y", "replace X with Y", "cambia X por Y"). **Delete the old object.** This is a standing instruction from the user, so it needs no separate confirmation; the substitution request is the authorisation.
- **A plain removal** — the user just takes a book off with nothing replacing it. **Leave the object in place** unless they ask for it gone. It costs nothing, and re-adding later needs no re-upload.

```bash
wrangler r2 object delete personalweb/books/<slug>.webp --remote
curl -sI "https://cv.htarrega.me/books/<slug>.webp?cb=$RANDOM" | head -1   # expect HTTP/2 404
```

**Verify over HTTP, not with `wrangler r2 object get`.** Observed on wrangler 4.58.0: minutes after a successful delete, `object get --remote --pipe` still returned the full original payload with exit 0, while the public URL returned 404 with `cf-cache-status: DYNAMIC` — an uncached, straight-to-origin miss. The API read path is cached; the edge read is authoritative. Trusting `object get` here reports a delete as failed when it succeeded. Add the `?cb=` query so you cannot be fooled in the other direction by an edge-cached 200.

Deleting is irreversible — the WebP is a build artifact, so recovering it means re-running steps 1–3. Confirm you have the right slug before firing, and never delete the slug you just uploaded.

## Working in Spanish

The user frequently writes the request in Spanish while the shelf itself is titled in English. Two separate decisions follow, and they are independent:

- **Which title to store.** Default to the **English/original edition title**, because that is what the rest of `books.json` uses — a lone Spanish title reads as a mistake on the shelf. Store the Spanish one only if the user asks for it ("déjalo en español", "con el título español").
- **Which edition to source artwork from.** Always whichever one iTunes actually has, regardless of the title you store. These need not match.

Spanish-language requests also tend to give an approximate title from memory. Confirm the real one before searching — `"Así en la tierra como debajo de ella"` was the user's rendering of Ana Paula Maia's *Así en la tierra como debajo de **la tierra***, and the wrong string returns nothing from iTunes. A web search on the approximate title resolves the author and the exact wording, and from there the English edition.

## Notes
- The cover WebP is a build artifact — write it to a scratch/temp dir, not into the repo. Only `books.json` gets committed.
- The bookshelf falls back to a text tile if a cover 404s, so always confirm the R2 URL serves (step 3) before deploying.
- If the user wants the Spanish title displayed, use it for `title` but still source the cover from whichever edition has artwork.
