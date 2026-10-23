"""Render PNG icons + link preview from the SVGs. Run from the project root."""
import pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path('.').resolve()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    for src, out, size in [('icons/icon.svg','icons/icon-512.png',512), ('icons/icon.svg','icons/icon-192.png',192),
                           ('icons/icon.svg','icons/apple-touch-icon.png',180), ('tools/_maskable.svg','icons/maskable-512.png',512)]:
        svg = (root/src).read_text(encoding='utf-8')
        pg.set_viewport_size({'width': size, 'height': size})
        pg.set_content(f'<html><body style="margin:0;background:transparent">{svg.replace("<svg ", f"<svg width={size} height={size} ",1)}</body></html>')
        pg.screenshot(path=out, omit_background=True, clip={'x':0,'y':0,'width':size,'height':size})
    pg.set_viewport_size({'width':1200,'height':630})
    pg.goto((root/'tools/_og.html').as_uri()); pg.wait_for_load_state('networkidle'); pg.evaluate('document.fonts.ready')
    pg.screenshot(path='icons/og.png', clip={'x':0,'y':0,'width':1200,'height':630})
    b.close()
print('pngs ok')
