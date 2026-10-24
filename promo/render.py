"""Render the promo video.

  python promo/render.py --preview 2.4 6 12 18 23.8 31.5 38.8 46   # a few stills -> promo/out/preview_*.png
  python promo/render.py                                           # full video -> promo/out/al-gutta-promo.mp4

Needs: a local web server on port 8765 serving the project root (python -m http.server 8765),
playwright (chromium), imageio-ffmpeg, numpy. Music comes from promo/music.py.
"""
import json, pathlib, subprocess, sys, shutil
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'out'; OUT.mkdir(exist_ok=True)
URL = 'http://localhost:8765/promo/scene.html'
TL = json.loads((ROOT / 'timeline.json').read_text(encoding='utf-8'))


def open_page(p):
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1080, 'height': 1920}, device_scale_factor=1)
    pg.goto(URL)
    pg.wait_for_function('window.READY === true', timeout=60000)
    pg.wait_for_timeout(500)
    return b, pg


def preview(times):
    with sync_playwright() as p:
        b, pg = open_page(p)
        for t in times:
            pg.evaluate(f'render({t})')
            pg.screenshot(path=str(OUT / f'preview_{t}.png'))
        b.close()


def full():
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    frames = OUT / 'frames'
    shutil.rmtree(frames, ignore_errors=True); frames.mkdir()
    fps, dur = TL['fps'], TL['duration']
    n = int(fps * dur)
    with sync_playwright() as p:
        b, pg = open_page(p)
        for i in range(n):
            pg.evaluate(f'render({i / fps})')
            pg.screenshot(path=str(frames / f'f{i:05d}.jpg'), type='jpeg', quality=92)
            if i % 150 == 0: print(f'frame {i}/{n}', flush=True)
        b.close()
    wav = OUT / 'music.wav'
    if not wav.exists():
        subprocess.run([sys.executable, str(ROOT / 'music.py')], check=True)
    mp4 = OUT / 'al-gutta-promo.mp4'
    subprocess.run([ff, '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', str(frames / 'f%05d.jpg'), '-i', str(wav),
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    '-c:a', 'aac', '-b:a', '192k', '-shortest', str(mp4)], check=True)
    print('wrote', mp4)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--preview':
        preview([float(x) for x in sys.argv[2:]])
    else:
        full()
