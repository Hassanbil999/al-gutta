"""Original music + sound effects for the promo, synthesized from scratch (no samples).

Maqam Bayati on D (with the E half-flat), an oud/qanbus-like plucked lute with rīsha tremolo,
darbuka dum/tak, riq jingles and wedding-style hand claps, over a low drone.
Sound effects follow promo/timeline.json.  Output: promo/out/music.wav
"""
import json, pathlib
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

ROOT = pathlib.Path(__file__).resolve().parent
TL = json.loads((ROOT / 'timeline.json').read_text(encoding='utf-8'))
SR = 44100
DUR = TL['duration']
N = int(SR * DUR)
rng = np.random.default_rng(7)

music = np.zeros((N, 2))
sfx = np.zeros((N, 2))


def add(bus, sig, t, pan=0.0, gain=1.0):
    i = int(t * SR)
    if i >= N or i + len(sig) <= 0: return
    if i < 0: sig = sig[-i:]; i = 0
    sig = sig[: N - i] * gain
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    bus[i:i + len(sig), 0] += sig * l * 1.41
    bus[i:i + len(sig), 1] += sig * r * 1.41


def tt(d): return np.arange(int(d * SR)) / SR
def bp(x, lo, hi, order=2): return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f, order=2): return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


# ---------------- maqam Bayati on D ----------------
D4 = 293.66
STEPS = [0, 1.5, 3, 5, 7, 8, 10, 12]          # semitones: D E½ F G A Bb C D
def deg(d, octave=0):
    o, k = divmod(d, 7)
    return D4 * 2 ** ((STEPS[k] + 12 * (o + octave)) / 12)


# ---------------- instruments ----------------
def pluck(f, d, bright=1.0, amp=1.0):
    """oud/qanbus-like: additive harmonics with fast-decaying highs + a pick transient."""
    t = tt(d + 0.6)
    s = np.zeros_like(t)
    for k in range(1, 14):
        fk = f * k * (1 + 0.0004 * k * k)
        if fk > 12000: break
        a = (1 / k ** 1.05) * (1.3 if k in (2, 3) else 1.0) * (bright ** (k / 6))
        s += a * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28)) * np.exp(-t * (2.2 + 1.1 * k))
    env = np.minimum(1, t / 0.004)
    s *= env
    n = hp(rng.standard_normal(int(0.012 * SR)), 1500) * np.exp(-np.arange(int(0.012 * SR)) / (0.003 * SR))
    s[:len(n)] += 0.25 * n
    rel = np.ones_like(t); cut = int(d * SR)
    rel[cut:] = np.exp(-(np.arange(len(t) - cut)) / (0.08 * SR))
    return s * rel * amp * 0.35


def note(f, t0, d, amp=1.0, pan=-0.2, trem=False, bright=1.0):
    if trem and d > 0.35:          # rīsha tremolo on long notes
        k, step = 0, 1 / 13
        while k * step < d - 0.05:
            add(music, pluck(f, step * 1.2, bright, amp * (0.85 if k else 1.0)), t0 + k * step, pan)
            k += 1
    else:
        add(music, pluck(f, d, bright, amp), t0, pan)
        add(music, pluck(f * 2, d * 0.7, bright * 0.8, amp * 0.18), t0 + 0.012, pan + 0.15)   # octave course shimmer


def dum(amp=1.0):
    t = tt(0.4)
    f = 52 + 75 * np.exp(-t * 28)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    s += 0.3 * lp(rng.standard_normal(len(t)), 400) * np.exp(-t * 35)
    return s * amp * 0.9


def tak(amp=1.0):
    t = tt(0.12)
    s = bp(rng.standard_normal(len(t)), 1800, 6500) * np.exp(-t * 60)
    s += 0.5 * np.sin(2 * np.pi * 820 * t) * np.exp(-t * 70)
    return s * amp * 0.5


def riq(amp=1.0):
    t = tt(0.14)
    s = hp(rng.standard_normal(len(t)), 6500) * np.exp(-t * 40)
    for f in (5200, 6900, 8800): s += 0.15 * np.sin(2 * np.pi * f * t) * np.exp(-t * 30)
    return s * amp * 0.16


def clap(amp=1.0):
    t = tt(0.22); s = np.zeros_like(t)
    for off in (0, 0.007, 0.016, 0.024):
        i = int(off * SR); nlen = len(t) - i
        s[i:] += bp(rng.standard_normal(nlen), 900, 2600) * np.exp(-np.arange(nlen) / SR * (60 if off < 0.02 else 18))
    return s * amp * 0.32


def drone(t0, d, amp=0.06):
    t = tt(d)
    env = np.minimum(1, t / 2.5) * np.minimum(1, (d - t) / 2.5)
    s = np.zeros_like(t)
    for f, a in ((deg(0, -2), 1), (deg(4, -2), .6), (deg(0, -1), .35)):
        for k in range(1, 6):
            s += a / k * np.sin(2 * np.pi * f * k * t) * (1 + 0.15 * np.sin(2 * np.pi * 0.2 * t + k))
    s = lp(s, 900)
    add(music, s * env * amp, t0, 0.0)


# ---------------- sound effects ----------------
def chime(f, amp=1.0, d=1.6):
    t = tt(d); s = np.zeros_like(t)
    for ratio, a, dec in ((1, 1, 2.2), (2.76, .5, 4), (5.4, .25, 7), (8.93, .12, 10)):
        s += a * np.sin(2 * np.pi * f * ratio * t) * np.exp(-t * dec)
    return s * np.minimum(1, t / 0.002) * amp * 0.22


def whoosh(d=0.55, up=True, amp=1.0):
    n = int(d * SR); x = rng.standard_normal(n); y = np.zeros(n); z = 0.0
    for i in range(n):
        p = i / n; fc = 300 + 5000 * (p if up else 1 - p) ** 1.5
        a = 1 - np.exp(-2 * np.pi * fc / SR); z += a * (x[i] - z); y[i] = z
    env = np.sin(np.pi * np.linspace(0, 1, n)) ** 2
    return y * env * amp * 0.5


def coin(amp=1.0):
    t = tt(0.5); s = np.zeros_like(t)
    for f, a, dec in ((2350, 1, 9), (3520, .7, 12), (4870, .5, 15), (6230, .3, 20)):
        s += a * np.sin(2 * np.pi * f * (1 + 0.002 * rng.standard_normal()) * t) * np.exp(-t * dec)
    s[:200] += hp(rng.standard_normal(200), 3000) * 0.6
    return s * amp * 0.13


def tap(amp=1.0):
    t = tt(0.06)
    return (np.sin(2 * np.pi * 1400 * t) * np.exp(-t * 90) + 0.4 * hp(rng.standard_normal(len(t)), 2000) * np.exp(-t * 200)) * amp * 0.28


def pop(amp=1.0):
    t = tt(0.12); f = 320 + 900 * (1 - np.exp(-t * 40))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 28) * amp * 0.35


def ticks(d=0.9, amp=1.0):
    out = np.zeros(int(d * SR)); k = 0
    while k * 0.045 < d:
        c = tap(0.35); i = int(k * 0.045 * SR); out[i:i + len(c)] += c[:len(out) - i]; k += 1
    return out * amp


SFX = {
    'whoosh': lambda t: add(sfx, whoosh(0.5), t - 0.3, 0, 0.55),
    'title':  lambda t: [add(sfx, dum(1.2), t, 0), [note(deg(k, o), t + 0.03 * j, 1.4, 0.9, -0.1) for j, (k, o) in enumerate(((0, -1), (4, -1), (0, 0), (2, 0)))]],
    'coin':   lambda t: add(sfx, coin(), t, rng.uniform(-.6, .6), 0.9),
    'gather': lambda t: [add(sfx, whoosh(0.45, False), t - 0.35, 0, 0.5), add(sfx, dum(0.7), t + 0.1, 0)],
    'tap':    lambda t: add(sfx, tap(), t, 0.1),
    'pop':    lambda t: add(sfx, pop(), t, -0.1),
    'send':   lambda t: add(sfx, whoosh(0.9, True), t, -0.4, 0.7),
    'ping':   lambda t: [add(sfx, chime(deg(4, 1)), t, 0.3, 0.9), add(sfx, chime(deg(7, 1)), t + 0.12, 0.3, 0.8)],
    'count':  lambda t: add(sfx, ticks(0.9), t, 0, 0.6),
    'split':  lambda t: [add(sfx, whoosh(0.35, True), t - 0.1, 0, 0.6)] + [add(sfx, chime(deg(k, 1), 0.8, 1.0), t + 0.3 * j + 0.65, [.5, 0, -.5][j]) for j, k in enumerate((0, 2, 4))],
    'chime':  lambda t: [add(sfx, chime(deg(k, 1), 0.6), t + 0.09 * j, (j - 1.5) * 0.3) for j, k in enumerate((0, 2, 4, 7))],
    'sparkle': lambda t: [add(sfx, dum(1.3), t, 0), add(sfx, clap(1.0), t, 0)] +
                         [add(sfx, chime(deg(int(rng.integers(0, 8)), 1 + int(rng.integers(0, 2))), rng.uniform(.25, .6), 1.4), t + rng.uniform(0, 1.3), rng.uniform(-.8, .8)) for _ in range(22)] +
                         [note(deg(k, o), t + 0.025 * j, 2.2, 1.0, (j - 2) * 0.2) for j, (k, o) in enumerate(((0, -1), (4, -1), (0, 0), (2, 0), (4, 0)))],
}

# ---------------- the music ----------------
BEAT = 60 / 96; E8 = BEAT / 2; BAR = BEAT * 4
T0 = 4.6                       # rhythm starts with the second scene
SETTLE = 38.35                 # the big moment
END_RHYTHM = 44.6

drone(0, DUR, 0.05)

# taqsim (free intro) — answers the window lighting up
for t, d, k, o, tr in ((0.25, 0.9, 0, 0, True), (1.25, 0.35, 1, 0, False), (1.6, 0.35, 2, 0, False), (1.95, 0.6, 3, 0, True),
                       (2.6, 0.3, 2, 0, False), (2.9, 0.3, 1, 0, False), (3.2, 1.3, 0, 0, True)):
    note(deg(k, o), t, d, 0.8, -0.2, tr)
# pane chimes as the qamariya builds (arch panes only)
for i in range(15):
    add(sfx, chime(deg(i % 8, 1), 0.28, 1.2), 0.3 + i * 0.075 + 0.08, (i / 14 - 0.5) * 1.2)

A = [(4, 2), (3, 1), (2, 1), (3, 2), (2, 1), (1, 1), (2, 2), (1, 1), (0, 1), (1, 2), (0, 2)]
B = [(4, 1), (5, 1), (6, 2), (7, 2), (6, 1), (5, 1), (4, 2), (5, 1), (4, 1), (3, 2), (2, 1), (1, 1)]

def phrase(seq, t0, octave=0, amp=0.85, trem_from=2):
    t = t0
    for k, n8 in seq:
        d = n8 * E8
        note(deg(k, octave), t, d * 0.95, amp, -0.25, trem=n8 >= trem_from)
        t += d
    return t

# melody plan (bar index from T0)
plan = {2: ('A', 0), 4: ('A', 0), 6: ('B', 0), 8: ('B', 0), 10: ('A', 1), 12: ('B', 0)}
for bar, (which, octv) in plan.items():
    phrase(A if which == 'A' else B, T0 + bar * BAR, octv, 0.75 if octv else 0.85)
# after the settle: B then cadence home on D
t = phrase(B, SETTLE + 0.05, 0, 0.9)
t = phrase([(2, 1), (1, 1)], t, 0, 0.85)
note(deg(0), t, 2.6, 0.95, -0.2, trem=True)
note(deg(0, -1), t, 2.6, 0.5, 0.2)
note(deg(4, -1), 45.9, 1.8, 0.45, 0.2)
note(deg(0), 46.2, 1.6, 0.6, -0.1, trem=True)

# rhythm: dum dum . tak dum . tak .
PAT = ['D', 'D', None, 'T', 'D', None, 'T', None]
bar = 0
while True:
    b0 = T0 + bar * BAR
    if b0 >= END_RHYTHM: break
    for j, hit in enumerate(PAT):
        t = b0 + j * E8
        if SETTLE - 1.25 < t < SETTLE: continue            # leave room for the drum roll
        if t >= END_RHYTHM: break
        amp = 0.8 if bar < 2 else 1.0
        if hit == 'D': add(music, dum(amp), t, 0)
        elif hit == 'T': add(music, tak(amp), t, 0.05)
        add(music, riq(0.7 if j % 2 else 1.0), t + E8 / 2 * (j % 2), 0.35)
        if bar >= 6 and j in (2, 6): add(music, clap(0.9), t, -0.5); add(music, clap(0.7), t + 0.01, 0.5)
        if j in (0, 4): note(deg(0 if (bar % 2 == 0 or j == 0) else 4, -1 if j == 0 else -2), t, 0.25, 0.35, 0.25)
    bar += 1
# drum roll into the settle
k = 0
while SETTLE - 1.25 + k * (E8 / 2) < SETTLE - 0.02:
    add(music, tak(0.3 + 0.7 * k / 16), SETTLE - 1.25 + k * (E8 / 2), 0)
    k += 1
# after the settle, a lighter rhythm keeps going until the outro
for ev, t in TL['sfx']:
    SFX[ev](t)

# ---------------- mix ----------------
def reverb(x, secs=1.8, wet=0.22):
    n = int(secs * SR)
    ir = rng.standard_normal((n, 2)) * np.exp(-np.arange(n) / SR * 3.2)[:, None]
    ir = lp(ir.T, 6000).T
    ir /= np.sqrt((ir ** 2).sum(0))
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1)
    return x * (1 - wet) + y * wet * 1.5

mix = reverb(music, wet=0.24) * 0.8 + reverb(sfx, 1.2, 0.18) * 1.0
fade_in, fade_out = int(0.05 * SR), int(1.2 * SR)
mix[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
mix[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.6) / np.tanh(1.6) * 0.92            # gentle limiter
out = ROOT / 'out'; out.mkdir(exist_ok=True)
wavfile.write(out / 'music.wav', SR, (mix * 32767).astype(np.int16))
print('wrote', out / 'music.wav')
