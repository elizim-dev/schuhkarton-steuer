"""Erzeugt die App-Icons (Schuhkarton mit Deckel und Beleg)."""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
S = 1024


def draw(maskable=False):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bg = (244, 233, 220, 255)
    if maskable:
        d.rectangle([0, 0, S, S], fill=bg)
        scale, off = 0.72, S * 0.14
    else:
        d.rounded_rectangle([0, 0, S, S], radius=230, fill=bg)
        scale, off = 0.86, S * 0.07

    def P(x, y):
        return (off + x * scale * S, off + y * scale * S)

    karton = (168, 115, 63, 255)
    dunkel = (125, 82, 40, 255)
    papier = (255, 255, 255, 255)
    linie = (200, 185, 168, 255)

    # Beleg ragt aus dem Karton
    d.rounded_rectangle([*P(0.30, 0.10), *P(0.70, 0.62)], radius=int(18 * scale), fill=papier, outline=linie, width=int(10 * scale))
    for i, w in enumerate([0.28, 0.22, 0.26, 0.16]):
        y = 0.20 + i * 0.075
        d.rounded_rectangle([*P(0.36, y), *P(0.36 + w, y + 0.03)], radius=int(8 * scale), fill=linie)
    # Euro-Zeichen-Andeutung: Betragszeile
    d.rounded_rectangle([*P(0.50, 0.50), *P(0.64, 0.545)], radius=int(8 * scale), fill=karton)

    # Karton
    d.rounded_rectangle([*P(0.12, 0.48), *P(0.88, 0.90)], radius=int(26 * scale), fill=karton)
    # Deckel (leicht schräg angelehnt dargestellt als Band)
    d.rounded_rectangle([*P(0.08, 0.42), *P(0.92, 0.56)], radius=int(22 * scale), fill=dunkel)
    # Griffloch
    d.rounded_rectangle([*P(0.40, 0.66), *P(0.60, 0.72)], radius=int(20 * scale), fill=dunkel)
    return img


icon = draw()
for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon-raw.png")]:
    icon.resize((size, size), Image.LANCZOS).save(f"{OUT}/{name}")
# Apple: ohne Transparenz
apple = Image.new("RGB", (180, 180), (244, 233, 220))
raw = draw(maskable=True).resize((180, 180), Image.LANCZOS)
apple.paste(raw, (0, 0), raw)
apple.save(f"{OUT}/apple-touch-icon.png")
draw(maskable=True).resize((512, 512), Image.LANCZOS).save(f"{OUT}/icon-512-maskable.png")
import os
os.remove(f"{OUT}/apple-touch-icon-raw.png")
print("ok")
