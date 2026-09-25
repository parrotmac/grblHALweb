// Minimal G-code interpreter for the toolpath preview: linear and XY-plane arc
// motion, absolute/relative and mm/inch modes. Everything else is ignored;
// the firmware is the authority on what the program really does.

const MAX_ARC_SEGMENT_MM = 0.5;

export function parseGcode(text) {
  const positions = [];   // pairs of xyz points, one pair per segment
  const rapid = [];       // per segment: 1 = G0
  const lineOf = [];      // per segment: source line index
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  let pos = [0, 0, 0];
  let absolute = true, scale = 1, motion = 0, plane = 17;

  const push = (a, b, isRapid, line) => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    rapid.push(isRapid ? 1 : 0);
    lineOf.push(line);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], a[i], b[i]);
      max[i] = Math.max(max[i], a[i], b[i]);
    }
  };

  text.split(/\r?\n/).forEach((raw, lineIndex) => {
    const line = raw.replace(/\(.*?\)|;.*$/g, '').toUpperCase();
    const words = {};
    const gs = [];
    for (const [, letter, value] of line.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) {
      if (letter === 'G') gs.push(parseFloat(value));
      else words[letter] = parseFloat(value);
    }

    let nonModalAxes = false;
    for (const g of gs) {
      if (g <= 3) motion = g;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 20) scale = 25.4;
      else if (g === 21) scale = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if ([10, 28, 30, 53, 92].includes(Math.floor(g))) nonModalAxes = true;
    }

    const hasAxis = 'X' in words || 'Y' in words || 'Z' in words;
    if (nonModalAxes || !hasAxis) return;

    const target = pos.slice();
    ['X', 'Y', 'Z'].forEach((axis, i) => {
      if (axis in words) target[i] = absolute ? words[axis] * scale : pos[i] + words[axis] * scale;
    });

    if ((motion === 2 || motion === 3) && plane === 17) {
      arc(pos, target, words, scale, motion === 2, (a, b) => push(a, b, false, lineIndex));
    } else {
      push(pos, target, motion === 0, lineIndex);
    }
    pos = target;
  });

  return {
    positions: new Float32Array(positions),
    rapid: Uint8Array.from(rapid),
    lineOf: Uint32Array.from(lineOf),
    bounds: positions.length ? { min, max } : null,
  };
}

// Same center and sweep computation as grblHAL's gcode.c / motion_control.c
function arc(start, target, words, scale, clockwise, emit) {
  const x = target[0] - start[0];
  const y = target[1] - start[1];
  let i, j;

  if ('R' in words) {
    const r = words.R * scale;
    let h = 4 * r * r - x * x - y * y;
    if (h < 0) return emit(start, target);
    h = -Math.sqrt(h) / Math.hypot(x, y);
    if (!clockwise) h = -h;
    if (r < 0) h = -h;
    i = 0.5 * (x - y * h);
    j = 0.5 * (y + x * h);
  } else {
    i = (words.I ?? 0) * scale;
    j = (words.J ?? 0) * scale;
  }

  const cx = start[0] + i, cy = start[1] + j;
  const r0x = -i, r0y = -j;
  const rtx = target[0] - cx, rty = target[1] - cy;
  const radius = Math.hypot(r0x, r0y);

  let sweep = Math.atan2(r0x * rty - r0y * rtx, r0x * rtx + r0y * rty);
  if (clockwise) { if (sweep >= -1e-7) sweep -= 2 * Math.PI; }
  else if (sweep <= 1e-7) sweep += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(sweep) * radius / MAX_ARC_SEGMENT_MM));
  const a0 = Math.atan2(r0y, r0x);
  let prev = start;
  for (let n = 1; n <= segments; n++) {
    const t = n / segments;
    const a = a0 + sweep * t;
    const p = n === segments
      ? target
      : [cx + radius * Math.cos(a), cy + radius * Math.sin(a), start[2] + (target[2] - start[2]) * t];
    emit(prev, p);
    prev = p;
  }
}
