---
name: add-book
description: Add a book to the htarrega.me bookshelf. Use when asked to add/añadir a book, libro, or novel to the bookshelf/estantería — fetches the cover via the iTunes Search API (the iTunes Artwork Finder backend), uploads it to Cloudflare R2, appends the entry to resources/books.json, and deploys via git push. Repo-specific (static-web).
argument-hint: [book title, optionally author]
allowed-tools: Bash, Read, Write, Edit
---

# Add a book to the htarrega.me bookshelf

This repo (`static-web`) is a static site deployed to **GitHub Pages** (`CNAME` → htarrega.me, remote `htarrega/static-web`): pushing to `master` publishes. The bookshelf page (`bookshelf.html`) fetches `resources/books.json` and renders each entry from a `title`, `author`, and `cover` URL. Covers are **not** committed to the repo — they live in the Cloudflare R2 bucket `personalweb` under the `books/` prefix and are served from `https://cv.htarrega.me/books/<slug>.webp`.

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

Add one object to the end of the array in `resources/books.json`. Keep the author style consistent with the rest of the file — plain author name, no translator (unless the book is credited to a translator, as with a few existing entries):

```json
  {
    "title": "When We Cease to Understand the World",
    "author": "Benjamín Labatut",
    "cover": "https://cv.htarrega.me/books/when_we_cease.webp"
  }
```

Then validate:

```bash
python3 -c "import json; d=json.load(open('resources/books.json')); print('valid,', len(d), 'books; last:', d[-1]['title'])"
```

## 5. Deploy

Publishing = push to `master` (GitHub Pages auto-deploys in ~1 min). Stage **only** `resources/books.json` — never `node_modules/`, `.wrangler/`, or the local `books/` scratch dir:

```bash
git add resources/books.json
git commit -m "Add '<Title>' to bookshelf"
git push origin master
```

The book is then live on `https://htarrega.me/bookshelf.html`.

## Notes
- The cover WebP is a build artifact — write it to a scratch/temp dir, not into the repo. Only `books.json` gets committed.
- The bookshelf falls back to a text tile if a cover 404s, so always confirm the R2 URL serves (step 3) before deploying.
- If the user wants the Spanish title displayed, use it for `title` but still source the cover from whichever edition has artwork.
