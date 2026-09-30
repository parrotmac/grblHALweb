// SPDX-License-Identifier: LGPL-3.0-or-later
// Cutting tools for stock simulation, as radial profiles: h(r) is the height
// of the cutting surface above the tool tip at distance r from the axis.
//
// A tool spec, mm (and degrees):
//   diameter      cutting diameter
//   length        stick-out below the collet face
//   shape         'flat' (default), 'ball', 'bull' or 'v'
//   angle         V bit included angle (default 90)
//   tipDiameter   V bit flat tip diameter (default 0)
//   cornerRadius  bull nose corner radius
//   fluteLength   length of the cutting flutes from the tip; material above
//                 them is hit by the shank (default: the whole stick-out)
//   shankDiameter (default: diameter)

// The collet nut around the collet face, as the machine view draws it: the
// part of the spindle that hits the stock first when a tool sticks out too
// little for a deep cut.
export const HOLDER_RADIUS = 14;

export const SHAPES = ['flat', 'ball', 'bull', 'v'];

// Returns the spec with defaults filled in and nonsense rejected, or null.
export function normalizeTool(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const diameter = num(spec.diameter, NaN);
  const length = num(spec.length, NaN);
  if (!(diameter > 0) || !(length > 0)) return null;
  const shape = SHAPES.includes(spec.shape) ? spec.shape : 'flat';
  const tool = {
    diameter,
    length,
    shape,
    angle: Math.min(179, Math.max(1, num(spec.angle, 90))),
    tipDiameter: Math.max(0, Math.min(diameter, num(spec.tipDiameter, 0))),
    cornerRadius: Math.max(0, Math.min(diameter / 2, num(spec.cornerRadius, shape === 'bull' ? diameter / 8 : 0))),
    fluteLength: Math.max(0, Math.min(length, num(spec.fluteLength, length))),
    shankDiameter: Math.max(0, num(spec.shankDiameter, diameter)),
  };
  if (typeof spec.name === 'string') tool.name = spec.name.slice(0, 80);
  return tool;
}

// The profile the sweep uses: radius and h(r) for 0 <= r <= radius. All of
// them are convex and non-decreasing in r, which the sweep relies on.
export function toolProfile(tool) {
  const R = tool.diameter / 2;
  switch (tool.shape) {
    case 'ball':
      return { radius: R, flat: false, h: (r) => R - Math.sqrt(Math.max(0, R * R - r * r)) };
    case 'bull': {
      const rc = tool.cornerRadius;
      const flatR = R - rc;
      if (rc <= 0) return { radius: R, flat: true, h: () => 0 };
      return {
        radius: R,
        flat: false,
        h: (r) => {
          if (r <= flatR) return 0;
          const u = r - flatR;
          return rc - Math.sqrt(Math.max(0, rc * rc - u * u));
        },
      };
    }
    case 'v': {
      const slope = 1 / Math.tan((tool.angle * Math.PI) / 360);
      const tipR = tool.tipDiameter / 2;
      return { radius: R, flat: false, h: (r) => (r <= tipR ? 0 : (r - tipR) * slope) };
    }
    default:
      return { radius: R, flat: true, h: () => 0 };
  }
}
