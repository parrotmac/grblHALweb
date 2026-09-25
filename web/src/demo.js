// Demo job in work coordinates: a rounded-rectangle profile, a spiral pocket
// and an engraved star. Work zero is the top left-front corner of the stock.

const f = (n) => +n.toFixed(3);

export function demoProgram() {
  const out = [
    '(grblHALweb demo)',
    'G21 G90 G17 G94',
    'G0 Z5',
    'M3 S18000',
    'M8',
    'G4 P1',
  ];

  // Profile: 80 x 60 rounded rectangle, 3 passes of 1 mm.
  const r = 6, w = 80, h = 60;
  for (let z = -1; z >= -3; z--) {
    out.push(`G0 X${r} Y0`, `G1 Z${z} F300`, 'F1200');
    out.push(`G1 X${w - r}`, `G3 X${w} Y${r} I0 J${r}`);
    out.push(`G1 Y${h - r}`, `G3 X${w - r} Y${h} I${-r} J0`);
    out.push(`G1 X${r}`, `G3 X0 Y${h - r} I0 J${-r}`);
    out.push(`G1 Y${r}`, `G3 X${r} Y0 I${r} J0`);
    out.push('G0 Z5');
  }

  // Spiral pocket, center (24, 30), 2 mm deep.
  const cx = 24, cy = 30;
  out.push(`G0 X${cx} Y${cy}`, 'G1 Z-2 F300', 'F900');
  for (let rad = 1.5; rad <= 12; rad += 1.5) {
    out.push(`G1 X${cx + rad} Y${cy}`, `G2 X${cx + rad} Y${cy} I${-rad} J0`);
  }
  out.push('G0 Z5');

  // Engraved five point star, center (58, 30).
  const sx = 58, sy = 30, outer = 12, inner = 5;
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? inner : outer;
    pts.push([sx + rr * Math.cos(a), sy + rr * Math.sin(a)]);
  }
  out.push(`G0 X${f(pts[0][0])} Y${f(pts[0][1])}`, 'G1 Z-0.5 F300', 'F1500');
  for (const [x, y] of pts.slice(1)) out.push(`G1 X${f(x)} Y${f(y)}`);
  out.push('G0 Z5');

  out.push('M9', 'M5', 'G0 X0 Y0 Z20', 'M30');
  return out.join('\n');
}

// Applied to a factory fresh controller (and again whenever PRESET_VERSION
// changes) so the demo feels like a real small router: faster axes, homing
// with limit switches, a 24k spindle and a work offset over the middle of the
// table. The offset is relative to the homed origin, so homing is required at
// power on ($22 bit 2) - otherwise jobs land wherever the machine woke up.
export const PRESET_VERSION = 2;

export const machinePreset = [
  '$100=250', '$101=250', '$102=400',
  '$110=6000', '$111=6000', '$112=2000',
  '$120=500', '$121=500', '$122=250',
  '$130=300', '$131=200', '$132=80',
  '$22=5', '$23=0', '$24=150', '$25=2000', '$27=2',
  '$20=1', '$21=1',
  '$30=24000', '$31=0',
  '$10=511',
  'G10 L2 P1 X-190 Y-130 Z-70',
];
