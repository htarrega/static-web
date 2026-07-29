"""Derive each book's cloth binding from its own jacket.

Usage:  python3 scripts/derive-spines.py

Re-run after adding books: it fills in spineColor / spineInk for every entry
in resources/books.json. Entries without them fall back to a hash palette in
bookshelf.html, so running this is an improvement, never a requirement.

Samples the left strip of the cover — the part that wraps onto the spine on a
real dust jacket — picks the dominant colour, then conditions it for a black
page: a lightness floor so it doesn't vanish into the ground, a ceiling so it
doesn't glare, and an ink chosen to clear WCAG AA against it.

Runs offline on purpose. cv.htarrega.me serves the covers without CORS
headers, so the browser can display them but can never read their pixels;
here we just download them.
"""
import colorsys, json, os, subprocess, tempfile
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(tempfile.gettempdir(), "htarrega-cover-cache")

STRIP = 0.16        # fraction of the cover width that becomes the spine
L_FLOOR, L_CEIL = 0.20, 0.82
MIN_CONTRAST = 4.5


def srgb_lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = (srgb_lin(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v))) for v in rgb)


def dominant(img):
    """Most-used colour in the strip, preferring one that actually has a hue."""
    q = img.convert("RGB").quantize(colors=8, method=Image.MEDIANCUT)
    pal = q.getpalette()
    counts = sorted(q.getcolors(), reverse=True)          # [(count, index), ...]
    total = sum(c for c, _ in counts)

    best, best_score = None, -1
    for count, idx in counts:
        rgb = tuple(pal[idx * 3: idx * 3 + 3])
        h, l, s = colorsys.rgb_to_hls(*[v / 255 for v in rgb])
        share = count / total
        # Weight by how much of the strip it covers, but stop near-white and
        # near-black from winning on area alone when a real hue is present.
        score = share
        if s < 0.12:
            score *= 0.55
        if l > 0.92 or l < 0.06:
            score *= 0.35
        if score > best_score:
            best, best_score = rgb, score
    return best


def condition(rgb):
    """Keep the jacket's hue; make it legible as cloth on a black page."""
    h, l, s = colorsys.rgb_to_hls(*[v / 255 for v in rgb])

    # HLS saturation is meaningless at the extremes — a near-white pixel can
    # report s > 0.7 off a couple of points of spread. Clamping without this
    # guard turned an ivory jacket into gold.
    if l > 0.85:
        s = min(s, 0.10)
    elif l < 0.10:
        s = min(s, 0.30)
    elif s >= 0.06:
        s = max(0.18, min(0.72, s))

    # Remap rather than clamp. A hard floor collapsed every dark jacket onto
    # the same grey; this lifts them clear of the page while keeping them
    # distinguishable from each other.
    l = L_FLOOR + (L_CEIL - L_FLOOR) * l

    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return (r * 255, g * 255, b * 255), h, l, s


def ink_for(cloth, hue):
    """Off-white or near-black, tinted with the cloth's hue, that clears AA.

    Searches both directions: for a mid-tone cloth neither family is
    guaranteed to reach AA, and picking by the cloth's luminance alone left
    some spines at 3.7:1.
    """
    best, best_c = None, -1
    for step in range(16):
        for l, s in ((0.16 - step * 0.011, 0.30), (0.90 + step * 0.006, 0.16)):
            r, g, b = colorsys.hls_to_rgb(hue, max(0.02, min(0.985, l)), s)
            cand = (r * 255, g * 255, b * 255)
            c = contrast(cand, cloth)
            if c > best_c:
                best, best_c = cand, c
            if c >= MIN_CONTRAST:
                return cand
    return best


books = json.load(open(os.path.join(ROOT, "resources/books.json")))
os.makedirs(CACHE, exist_ok=True)
rows, done = [], 0

for b in books:
    fn = os.path.join(CACHE, b["cover"].rsplit("/", 1)[-1])
    if not os.path.exists(fn):
        subprocess.run(["curl", "-sL", "--max-time", "25", b["cover"], "-o", fn], check=False)
    try:
        im = Image.open(fn).convert("RGB")
    except Exception as e:
        rows.append((b["title"], None, None, "no image: %s" % e))
        continue

    w, h = im.size
    strip = im.crop((0, int(h * 0.04), max(2, int(w * STRIP)), int(h * 0.96)))
    strip.thumbnail((60, 400))

    raw = dominant(strip)
    cloth, hue, _, _ = condition(raw)
    ink = ink_for(cloth, hue)

    b["spineColor"] = hexof(cloth)
    b["spineInk"] = hexof(ink)
    # Baked so the page never has to download a jacket just to learn how wide
    # the volume is. Without it the shelf cannot lay out until every cover has
    # arrived — 1.4 MB before anything appears.
    b["ratio"] = round(w / h, 3)
    rows.append((b["title"], hexof(raw), b["spineColor"],
                 "%s  contrast %.1f" % (b["spineInk"], contrast(ink, cloth))))
    done += 1

with open(os.path.join(ROOT, "resources/books.json"), "w") as f:
    json.dump(books, f, indent=2, ensure_ascii=False)
    f.write("\n")

for title, raw, cloth, note in rows:
    print(f"{(raw or '-'):<9} -> {(cloth or '-'):<9} {note:<26} {title[:36]}")
print(f"\n{done}/{len(books)} bindings derived from their jackets")
