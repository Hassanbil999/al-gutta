// The qamariya (قمرية): the arched stained-glass window of Sana'a houses.
// Its glass shifts with the balance; at zero every pane is lit — the window is whole.

const C = { red: '#B8322A', saffron: '#E0A22B', green: '#2F7D5B', indigo: '#2C4A8A', turq: '#2E8C8C', rose: '#C8553D', gold: '#C98A1B' };

const PALETTES = {
  even:  { outer: [C.red, C.saffron, C.green, C.indigo, C.turq, C.indigo, C.green, C.saffron, C.red], inner: [C.indigo, C.green, C.red, C.green, C.indigo], sun: C.saffron },
  plus:  { outer: [C.green, C.saffron, C.turq, C.green, C.gold, C.green, C.turq, C.saffron, C.green], inner: [C.saffron, C.green, C.turq, C.green, C.saffron], sun: C.saffron },
  mixed: { outer: [C.green, C.saffron, C.turq, C.green, C.saffron, C.red, C.indigo, C.rose, C.red], inner: [C.green, C.saffron, C.saffron, C.indigo, C.red], sun: C.saffron },
  minus: { outer: [C.red, C.indigo, C.rose, C.red, C.indigo, C.red, C.rose, C.indigo, C.red], inner: [C.indigo, C.red, C.rose, C.red, C.indigo], sun: C.rose },
};

export const moodOf = (bal) => (Math.abs(bal) < 0.005 ? 'even' : bal > 0 ? 'plus' : 'minus');

const f = (n) => n.toFixed(2);
function wedge(cx, cy, r1, r2, a1, a2) {
  const p = (r, a) => `${f(cx + r * Math.cos(a))},${f(cy + r * Math.sin(a))}`;
  return `M${p(r1, a1)}L${p(r2, a1)}A${r2},${r2} 0 0 1 ${p(r2, a2)}L${p(r1, a2)}A${r1},${r1} 0 0 0 ${p(r1, a1)}Z`;
}
function fan(cx, cy, r1, r2, colors, startI) {
  const n = colors.length, gap = 0, out = [];
  for (let i = 0; i < n; i++) {
    const a1 = Math.PI + (Math.PI * i) / n + gap, a2 = Math.PI + (Math.PI * (i + 1)) / n - gap;
    out.push(`<path class="g" style="--i:${startI + i}" fill="${colors[i]}" d="${wedge(cx, cy, r1, r2, a1, a2)}"/>`);
  }
  return out.join('');
}

export function qamariya({ mood = 'even', variant = 'full', label = '' } = {}) {
  const P = PALETTES[mood] || PALETTES.even;
  const cx = 100, cy = 112, H = variant === 'full' ? 240 : 120;
  const pearls = Array.from({ length: 11 }, (_, i) => {
    const a = Math.PI + (Math.PI * (i + 0.5)) / 11;
    return `<circle cx="${f(cx + 87 * Math.cos(a))}" cy="${f(cy + 87 * Math.sin(a))}" r="2.3"/>`;
  }).join('');

  let lower = '';
  if (variant === 'full') {
    // lower panes: a gypsum diamond lattice over faint glass
    const cells = [];
    const cols = 4, rows = 4, x0 = 18, x1 = 182, y0 = 124, y1 = 232;
    const w = (x1 - x0) / cols, h = (y1 - y0) / rows;
    const tint = [P.outer[1], P.outer[3], P.outer[5], P.outer[7]];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = x0 + c * w, y = y0 + r * h, mx = x + w / 2, my = y + h / 2;
      cells.push(`<path class="g low" style="--i:${(r + c) % 9}" fill="${tint[(r + c) % 4]}" d="M${f(mx)},${f(y + 4)}L${f(x + w - 4)},${f(my)}L${f(mx)},${f(y + h - 4)}L${f(x + 4)},${f(my)}Z"/>`);
    }
    lower = `
      <rect x="18" y="124" width="164" height="108" class="backing"/>
      ${cells.join('')}
      <path class="lattice" d="M18,151H182M18,178H182M18,205H182M59,124V232M100,124V232M141,124V232"/>`;
  }

  const frame = variant === 'full'
    ? `M6,${H}V${cy}A94,94 0 0 1 194,${cy}V${H}Z`
    : `M6,${H}V${cy}A94,94 0 0 1 194,${cy}V${H}Z`;
  const opening = variant === 'full'
    ? `M18,232V${cy}A82,82 0 0 1 182,${cy}V232Z`
    : `M18,${H}V${cy}A82,82 0 0 1 182,${cy}V${H}Z`;

  return `<svg class="qamariya q-${variant}" viewBox="0 0 200 ${H}" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">
    <path class="frame" d="${frame}"/>
    <path class="backing" d="${opening}"/>
    <g class="glass">
      ${fan(cx, cy, 50, 80, P.outer, 0)}
      ${fan(cx, cy, 24, 46, P.inner, 2)}
      <path class="g sun" style="--i:4" fill="${P.sun}" d="M${cx - 20},${cy}A20,20 0 0 1 ${cx + 20},${cy}Z"/>
      ${lower}
    </g>
    <path class="lattice" d="${fanLines(cx, cy)}"/>
    <rect class="transom" x="18" y="${cy}" width="164" height="${variant === 'full' ? 12 : 8}"/>
    <g class="pearls">${pearls}</g>
  </svg>`;
}

// gypsum ribs between the glass pieces
function fanLines(cx, cy) {
  const d = [];
  const arc = (r) => `M${cx - r},${cy}A${r},${r} 0 0 1 ${cx + r},${cy}`;
  d.push(arc(80), arc(48), arc(22));
  const ray = (n, r1, r2) => { for (let i = 1; i < n; i++) { const a = Math.PI + (Math.PI * i) / n; d.push(`M${f(cx + r1 * Math.cos(a))},${f(cy + r1 * Math.sin(a))}L${f(cx + r2 * Math.cos(a))},${f(cy + r2 * Math.sin(a))}`); } };
  ray(9, 48, 80); ray(5, 22, 48);
  return d.join('');
}
