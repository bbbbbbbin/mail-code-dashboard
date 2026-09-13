"""Rasterize the project's simple vector logo into browser/app icon formats.

Requires Pillow for icon maintenance only; not an application runtime dependency.
Geometry intentionally matches web/brand/logo.svg and has no external resources.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "web" / "brand"
SCALE = 16
SIZE = 64 * SCALE


def point(x, y):
    return (round(x * SCALE), round(y * SCALE))


def curve(a, b, c, d):
    for index in range(81):
        t = index / 80
        yield point(*((1 - t) ** 3 * a[i] + 3 * (1 - t) ** 2 * t * b[i] + 3 * (1 - t) * t * t * c[i] + t ** 3 * d[i] for i in range(2)))


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), 18 * SCALE, fill="#086f69")
    draw.polygon([point(*p) for p in [(13, 22), (32, 34), (51, 22), (51, 40), (13, 40)]], fill="#ffffff")
    draw.polygon([point(*p) for p in [(15, 18), (49, 18), (32, 29)]], fill="#c8f2e6")
    wave = [*curve((13, 45), (20, 41), (25, 49), (32, 45)), *curve((32, 45), (39, 41), (44, 41), (51, 45))]
    draw.line(wave, fill="#8fe0c9", width=round(3.5 * SCALE), joint="curve")
    radius = 1.75 * SCALE
    for x, y in wave:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill="#8fe0c9")
    for name, size in [("icon-32.png", 32), ("apple-touch-icon.png", 180), ("logo-256.png", 256)]:
        image.resize((size, size), Image.Resampling.LANCZOS).save(DEST / name, optimize=True)
    image.resize((256, 256), Image.Resampling.LANCZOS).save(DEST / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("Brand icons exported: PNG 32/180/256 and ICO 16/32/48/64")


if __name__ == "__main__":
    main()
