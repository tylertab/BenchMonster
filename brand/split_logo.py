"""Split the BenchMonster logo into a transparent monster icon and wordmark.

    python brand/split_logo.py   (needs pillow, numpy, scipy)

Writes to frontend/public/brand/ and frontend/app/ (favicon/app icons):
  monster.png          the mascot, transparent background
  wordmark.png         "benchmonster" text for light backgrounds
  wordmark-dark.png    same, with the dark blue lightened for dark backgrounds
  tagline.png          "LLM BENCHMARKING PLATFORM"
  app/icon.png, app/apple-icon.png   square icon for the browser tab / home screen

For the monster, only background connected to the crop's border is removed, so
white areas inside the artwork (its eyes) stay opaque; for text, every
background pixel goes, including letter counters (b, e, o). Anti-aliased edges get
partial alpha via color-to-alpha against the estimated background color.
"""

import colorsys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "brand" / "source-logo.jpeg"
OUT = ROOT / "frontend" / "public" / "brand"
APP = ROOT / "frontend" / "app"

FG_DIST = 30  # color distance from background that counts as artwork
BG_DIST = 26  # pixels this close to the background may be flood-filled away


def estimate_background(img: np.ndarray) -> np.ndarray:
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    return np.median(border, axis=0)


def bands(mask: np.ndarray, min_gap: int = 12, min_pixels: int = 4) -> list[tuple[int, int]]:
    """Row ranges containing artwork, separated by at least min_gap empty rows."""
    rows = np.where(mask.sum(axis=1) >= min_pixels)[0]
    out, start, prev = [], rows[0], rows[0]
    for r in rows[1:]:
        if r - prev > min_gap:
            out.append((start, prev))
            start = r
        prev = r
    out.append((start, prev))
    return out


def cut(img: np.ndarray, bg: np.ndarray, top: int, bottom: int, pad: int = 6, holes: bool = False,
        enclosed_min_area: int | None = None) -> Image.Image:
    """Crop a band and make its background transparent.

    Background connected to the crop border is always removed. holes=True also
    removes every enclosed background-colored region (letter counters in b, e, o).
    enclosed_min_area removes only enclosed regions at least that large: gaps
    between the monster's limbs go, while its eyes and teeth (smaller, but just as
    white) stay opaque.
    """
    dist_all = np.linalg.norm(img - bg, axis=2)
    cols = np.where((dist_all[top:bottom + 1] > FG_DIST).sum(axis=0) > 0)[0]
    y0, y1 = max(top - pad, 0), min(bottom + pad + 1, img.shape[0])
    x0, x1 = max(cols[0] - pad, 0), min(cols[-1] + pad + 1, img.shape[1])
    crop = img[y0:y1, x0:x1]
    dist = dist_all[y0:y1, x0:x1]

    # Background = background-colored pixels connected to the crop's border.
    labels, n = ndimage.label(dist < BG_DIST)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    if holes:
        keep = set(range(1, n + 1))
    else:
        keep = set(edge)
        if enclosed_min_area:
            areas = ndimage.sum(np.ones_like(labels), labels, index=range(1, n + 1))
            keep |= {i for i, a in zip(range(1, n + 1), areas) if i not in edge and a >= enclosed_min_area}
    background = np.isin(labels, list(keep))

    # The page background is a gradient (whiter near the artwork), so estimate it
    # locally from nearby background pixels for the edge unmixing below.
    w = ndimage.gaussian_filter(background.astype(float), 12)
    local = np.stack([ndimage.gaussian_filter(crop[..., c] * background, 12) for c in range(3)], axis=2)
    bg = np.where(w[..., None] > 1e-3, local / np.maximum(w, 1e-3)[..., None], bg)
    fringe = ndimage.binary_dilation(background, iterations=3) & ~background

    # Color-to-alpha on the fringe: how far each channel is pushed from the background.
    over = np.where(crop > bg, (crop - bg) / np.maximum(255 - bg, 1), (bg - crop) / np.maximum(bg, 1))
    a = np.clip(over.max(axis=2), 0, 1)
    alpha = np.ones(crop.shape[:2])
    alpha[background] = 0
    alpha[fringe] = a[fringe]
    safe = np.maximum(alpha, 1e-6)[..., None]
    color = np.where(fringe[..., None], bg + (crop - bg) / safe, crop)
    rgba = np.dstack([np.clip(color, 0, 255), alpha * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, "RGBA")
    return im.crop(im.getbbox())


def lighten_blues(im: Image.Image) -> Image.Image:
    """Dark-mode wordmark: raise the dark blue ("bench") to a light blue; keep purple/orange."""
    arr = np.array(im).astype(float)
    out = arr.copy()
    for y, x in zip(*np.where(arr[..., 3] > 0)):
        r, g, b = arr[y, x, :3] / 255
        h, s, v = colorsys.rgb_to_hsv(r, g, b)
        if 0.55 <= h <= 0.66 and v < 0.85:  # blue, and dark enough to vanish on #0d0d0d
            r2, g2, b2 = colorsys.hsv_to_rgb(h, s * 0.75, min(1.0, v + 0.42))
            out[y, x, :3] = (r2 * 255, g2 * 255, b2 * 255)
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def square_icon(icon: Image.Image, size: int, pad: float = 0.06, bg=None) -> Image.Image:
    side = max(icon.size)
    canvas = Image.new("RGBA", (int(side * (1 + 2 * pad)),) * 2, bg or (0, 0, 0, 0))
    canvas.alpha_composite(icon, ((canvas.width - icon.width) // 2, (canvas.height - icon.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    img = np.array(Image.open(SRC).convert("RGB")).astype(float)
    bg = estimate_background(img)
    fg = np.linalg.norm(img - bg, axis=2) > FG_DIST
    found = bands(fg)
    if len(found) != 3:
        raise SystemExit(f"expected 3 bands (icon, wordmark, tagline), found {found}")
    (it, ib), (wt, wb), (tt, tb) = found
    print("background", bg.round(1), "bands", found)

    OUT.mkdir(parents=True, exist_ok=True)
    icon = cut(img, bg, it, ib, enclosed_min_area=2200)
    wordmark = cut(img, bg, wt, wb, holes=True)
    tagline = cut(img, bg, tt, tb, holes=True)

    def save(im: Image.Image, name: str, max_w: int) -> None:
        if im.width > max_w:
            im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
        im.save(OUT / name, optimize=True)
        print(f"{name}: {im.size}")

    save(icon, "monster.png", 512)
    save(wordmark, "wordmark.png", 900)
    save(lighten_blues(wordmark), "wordmark-dark.png", 900)
    save(tagline, "tagline.png", 900)
    square_icon(icon, 512).save(APP / "icon.png", optimize=True)
    # iOS home screens don't honor transparency; give it a white tile.
    square_icon(icon, 180, pad=0.1, bg=(255, 255, 255, 255)).convert("RGB").save(APP / "apple-icon.png", optimize=True)
    print("icons: app/icon.png (512), app/apple-icon.png (180)")


if __name__ == "__main__":
    main()
