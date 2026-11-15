"""Draws the app icons (a rising line chart on black). Run once: python tools/make_icons.py"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def icon(size):
    s = 4  # supersample for smooth edges
    W = size * s
    im = Image.new("RGB", (W, W), (0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = W * 0.2
    pts = [(0.0, 0.78), (0.22, 0.62), (0.40, 0.68), (0.60, 0.40), (0.78, 0.48), (1.0, 0.18)]
    xy = [(pad + x * (W - 2 * pad), pad + y * (W - 2 * pad)) for x, y in pts]
    # soft area under the line
    area = xy + [(W - pad, W - pad), (pad, W - pad)]
    d.polygon(area, fill=(18, 40, 72))
    d.line(xy, fill=(57, 135, 229), width=int(W * 0.055), joint="curve")
    r = W * 0.045
    x, y = xy[-1]
    d.ellipse([x - r, y - r, x + r, y + r], fill=(76, 195, 138))
    return im.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    icon(size).save(os.path.join(OUT, name))
print("icons written to", OUT)
