---
name: publish-article
description: Publish a blog post to htarrega.me from an Obsidian vault article. Use when asked to publish/publicar an article, post, or essay to the site — handles image upload to Cloudflare R2, building the HTML with scripts/prepare-articles.sh, and deploying via git push. Repo-specific (static-web).
argument-hint: [article name in the vault]
allowed-tools: Bash, Read, Write, Edit
---

# Publish an article to htarrega.me

This repo (`static-web`) is a static site deployed to **GitHub Pages** (`CNAME` → htarrega.me, remote `htarrega/static-web`): pushing to `master` publishes. Articles are authored in the Obsidian vault "Mentat" and built into HTML with `scripts/prepare-articles.sh` (which runs `scripts/build-posts.js`).

Follow these steps in order. Do the image work only if the article embeds one.

## 1. Read the source article from the vault

The article lives in the Mentat vault, usually under `(300) Permanent/`. Read it with the `obs` skill CLI:

```bash
snap run obsidian search query="<name>" 2>/dev/null
snap run obsidian read path="(300) Permanent/<file>.md" 2>/dev/null
```

Expected format (this is what `build-posts.js` requires):
- A **table front matter** with rows `Title`, `Date`, `Excerpt`, followed by a separator line.
- Spanish body, then optionally `## [ENG]` marking the English translation (bilingual toggle is generated automatically).
- Images embedded Obsidian-style: `![[file.png|WIDTH]]` where WIDTH is the display width in px.

## 2. Handle the image (Cloudflare R2)

Images are **not** committed to the repo — they live in the R2 bucket `personalweb` under the `articles/` prefix and are served from `https://cv.htarrega.me/articles/`. `wrangler` is already authenticated on this machine. R2 commands **must** use `--remote` (local is the default and will fail).

For each embedded image `![[NAME.png|W]]`:

1. Find the source in the vault: `/home/htarrega/Documents/Mentat/(100) Attachments/images/NAME.png`.
2. Convert to WebP at **2× the display width** for retina (matches the site convention, e.g. `saint-binary-2x.webp` shown at width 260):
   ```bash
   convert "<src>" -resize $((W*2))x -quality 82 <name>-2x.webp
   ```
3. Upload to R2 with the right content-type:
   ```bash
   wrangler r2 object put personalweb/articles/<name>-2x.webp --remote \
     --file <name>-2x.webp --content-type image/webp
   ```
4. Verify it serves: `curl -sI https://cv.htarrega.me/articles/<name>-2x.webp` → expect `HTTP/2 200` and `content-type: image/webp`.

Write descriptive **alt text**, and prefer distinct alt per language block (Spanish alt in the ES section, English alt in the EN section) — see `posts/instinct.html` for the pattern.

## 3. Create the build draft

Copy the article body into `posts/drafts/<slug>.md` (kebab-case slug = the output filename). Two transforms are required vs. the vault version:

- **Front-matter separator must be `***`** (three asterisks on their own line) after the table. If the vault uses `---`, change it — `build-posts.js` only matches `***`.
- **Convert each image embed** `![[NAME.png|W]]` → `![<alt>|W](https://cv.htarrega.me/articles/<name>-2x.webp)`. The `|W` suffix on the alt sets the rendered `width` (the build ships the 2× file inside a W-px box → sharp on retina).

Keep the table header exactly `| Field | Content |` with a `| --- | --- |` separator row; rows `Title`, `Date`, `Excerpt` are all required or the build errors.

## 4. Build

```bash
bash scripts/prepare-articles.sh
```

This regenerates every `posts/<slug>.html` from `posts/drafts/*.md` and rewrites `resources/posts.json` (the index `posts.html` fetches, sorted by date desc). Confirm your new `posts/<slug>.html` was generated and the image `<img src=...>` and language toggle look right.

## 5. Deploy

Publishing = push to `master` (GitHub Pages auto-deploys in ~1 min). Stage **only** the article outputs — never `node_modules/`, `.wrangler/`, or `books/` (wrangler creates `node_modules/.mf`; `.gitignore` covers node_modules/ and .wrangler/):

```bash
git add posts/<slug>.html posts/drafts/<slug>.md resources/posts.json
git commit -m "Publish \"<Title>\" post"
git push origin master
```

The post is then live at `https://htarrega.me/posts/<slug>.html` and listed on `https://htarrega.me/posts.html`.

## Notes
- The vault article itself does not need editing; the `posts/drafts/<slug>.md` copy is the build input. Only edit the vault if the source content is wrong.
- Dates are free text like `July 2026`; posts sharing a date are ordered by title ascending.
