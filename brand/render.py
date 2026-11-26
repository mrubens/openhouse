#!/usr/bin/env python3
"""Renders brand/'s PNGs, favicon.ico and og.png from the SVGs, with headless Chrome and Pillow.

    python3 brand/render.py            (CHROME=... to point at another Chrome)
"""
import os, subprocess, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def shoot(html, w, h, out):
    with tempfile.TemporaryDirectory() as d:
        page = os.path.join(d, 'p.html')
        with open(page, 'w') as f:
            f.write(html)
        subprocess.run([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                        '--default-background-color=00000000', f'--window-size={w},{h}', f'--screenshot={out}',
                        'file://' + page], check=True, capture_output=True)


def svg(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


def page(body, w, h, bg='transparent'):
    return (f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;width:{w}px;height:{h}px;'
            f'background:{bg};overflow:hidden}}svg{{display:block;width:{w}px;height:{h}px}}</style></head>'
            f'<body>{body}</body></html>')


def main():
    big = os.path.join(HERE, 'logo-1024.tmp.png')
    shoot(page(svg('logo.svg'), 1024, 1024), 1024, 1024, big)
    img = Image.open(big).convert('RGBA')
    for n in (192, 512):
        img.resize((n, n), Image.LANCZOS).save(os.path.join(HERE, f'logo-{n}.png'), optimize=True)
    os.remove(big)

    # 16 and 32 (and favicon.ico) from favicon.svg: the same house, its line heavier so it holds at tab size.
    small = os.path.join(HERE, 'favicon-1024.tmp.png')
    shoot(page(svg('favicon.svg'), 1024, 1024), 1024, 1024, small)
    img = Image.open(small).convert('RGBA')
    for n in (16, 32):
        img.resize((n, n), Image.LANCZOS).save(os.path.join(HERE, f'logo-{n}.png'), optimize=True)
    img.resize((48, 48), Image.LANCZOS).save(os.path.join(HERE, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
    os.remove(small)

    # Full-bleed square: apple-touch-icon and the iPhone app's icon (iOS rounds both itself; no transparency), and the
    # maskable manifest icon (the house already sits inside the maskable safe circle).
    sq = os.path.join(HERE, 'square-1024.tmp.png')
    shoot(page(svg('logo-square.svg'), 1024, 1024), 1024, 1024, sq)
    img = Image.open(sq).convert('RGB')
    img.resize((180, 180), Image.LANCZOS).save(os.path.join(HERE, 'apple-touch-icon.png'), optimize=True)
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, 'maskable-512.png'), optimize=True)
    img.save(os.path.join(HERE, '..', 'ios', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'icon.png'), optimize=True)
    os.remove(sq)

    # The link preview: the logo and the wordmark on the site's page colour, in the site's type.
    og = ('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1200px;height:630px;'
          'background:#fbf9f5;overflow:hidden}body{display:flex;align-items:center;justify-content:center;gap:44px;'
          'font:600 112px/1 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:-.025em;'
          'color:#2a2826;-webkit-font-smoothing:antialiased}svg{width:176px;height:176px;flex:none}</style></head>'
          f'<body>{svg("logo.svg")}<span>Opie</span></body></html>')
    out = os.path.join(HERE, 'og.png')
    shoot(og, 1200, 630, out)
    Image.open(out).convert('RGB').save(out, optimize=True)


if __name__ == '__main__':
    main()
