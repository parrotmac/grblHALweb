// SPDX-License-Identifier: LGPL-3.0-or-later
// Stock simulation against shapes with known answers. Run: node --test web/test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stock, TILE } from '../src/stock/stock.js';
import { Cutter } from '../src/stock/cutter.js';
import { normalizeTool } from '../src/stock/tools.js';
import { SAMPLE, MOTION_RAPID } from '../src/sim/samples.js';

const box = { min: [0, 0, 0], max: [50, 20, 10] };
const flat6 = normalizeTool({ diameter: 6, length: 30 });
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} ${actual} ≉ ${expected} ± ${tol}`);

// Width of the cut at height z along x = 25: the span of cells lower than z.
function widthAt(stock, x, z) {
  let lo = Infinity, hi = -Infinity;
  for (let y = stock.cellY / 2; y < stock.max[1]; y += stock.cellY) {
    if (stock.heightAt(x, y) < z) {
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  return hi >= lo ? hi - lo + stock.cellY : 0;
}

test('a flat end mill cuts a slot of its diameter, to its depth', () => {
  const s = new Stock(box, { resolution: 0.05 });
  const r = s.cut([5, 10, 8], [45, 10, 8], flat6);
  near(s.heightAt(25, 10), 8, 1e-5);
  near(s.heightAt(25, 12.9), 8, 1e-5);
  near(s.heightAt(25, 13.1), 10, 1e-5);
  near(widthAt(s, 25, 9), 6, 0.1, 'slot width');
  near(r.depth, 2, 1e-5);
  near(r.removed, 2 * (40 * 6 + Math.PI * 9), 2, 'volume');
  assert.equal(r.shank, null);
  assert.equal(r.holder, null);
});

test('a ball end mill leaves its radius in the groove', () => {
  const s = new Stock(box, { resolution: 0.05 });
  s.cut([5, 10, 7], [45, 10, 7], normalizeTool({ diameter: 6, length: 30, shape: 'ball' }));
  for (const off of [0.025, 1.025, 2.025, 2.525]) {             // cell centres
    const expected = 7 + 3 - Math.sqrt(9 - off * off);
    near(s.heightAt(25, 10 + off), expected, 1e-4, `ball at ${off}`);
  }
});

test('a 90° V bit cuts twice its depth wide', () => {
  const s = new Stock(box, { resolution: 0.02 });
  s.cut([5, 10, 9], [45, 10, 9], normalizeTool({ diameter: 6, length: 30, shape: 'v', angle: 90 }));
  near(widthAt(s, 25, 10 - 1e-4), 2, 0.06, 'V width');
  near(s.heightAt(25, 10.51), 9.5, 0.03);
});

test('a ramp cuts down to where the tool leaves each point', () => {
  const s = new Stock(box, { resolution: 0.05 });
  s.cut([5, 10, 10], [25, 10, 8], flat6);
  // At x = 15 the tool's trailing edge (x - 3) passes at t = (15 + 3 - 5) / 20.
  near(s.heightAt(15.025, 10), 10 - 2 * ((15.025 + 3 - 5) / 20), 0.01);
  // A ball on a ramp: the lowest point over the path is on the path, 7 + depth under the centre.
  const b = new Stock(box, { resolution: 0.05 });
  b.cut([5, 10, 10], [25, 10, 7], normalizeTool({ diameter: 6, length: 30, shape: 'ball' }));
  near(b.heightAt(25.025, 10.025), 7, 0.01);
});

test('a plunge cuts a hole of the tool diameter', () => {
  const s = new Stock(box, { resolution: 0.05 });
  s.cut([25, 10, 12], [25, 10, 7], flat6);
  near(s.heightAt(25, 10), 7, 1e-5);
  near(s.heightAt(27.9, 10), 7, 1e-5);
  near(s.heightAt(28.1, 10), 10, 1e-5);
});

test('cutting through leaves nothing below the bottom', () => {
  const s = new Stock(box, { resolution: 0.1 });
  const r = s.cut([25, 10, 12], [25, 10, -2], flat6);
  assert.equal(s.heightAt(25, 10), 0);
  near(r.depth, 12, 1e-5);                      // how far the tool went into the material
  near(r.removed, 10 * Math.PI * 9, 3);         // but only the stock's 10 mm were there
  near(r.at[2], -2, 1e-5);
  assert.equal(s.cut([25, 10, 12], [25, 10, -3], flat6).depth, 0); // nothing left to cut
});

test('moves above the stock change nothing', () => {
  const s = new Stock(box, { resolution: 0.1 });
  s.takeDirtyTiles();
  const r = s.cut([0, 0, 15], [50, 20, 11], flat6);
  assert.equal(r.depth, 0);
  assert.equal(s.takeDirtyTiles().length, 0);
});

test('tiles carry a border at the bottom of the stock', () => {
  const s = new Stock({ min: [0, 0, 1], max: [10, 10, 5] }, { resolution: 0.1 });
  assert.equal(s.nx, 100);
  assert.equal(s.tilesX, 1);
  const [t] = s.takeDirtyTiles();
  const S = TILE + 3;
  assert.equal(t.data.length, S * S);
  assert.equal(t.data[0], 1);                 // outside: the bottom
  assert.equal(t.data[2 * S + 2], 5);         // cell 0, 0: the top
  s.cut([5, 5, 6], [5, 5, 4], flat6);
  assert.equal(s.takeDirtyTiles().length, 1);
});

// Samples as the firmware makes them: collet face positions, tipLength above the tip.
function samples(rows, tipLength = 30) {
  const stride = SAMPLE.AXES + 6;
  const data = new Float64Array(rows.length * stride);
  rows.forEach((r, k) => {
    const o = k * stride;
    data[o + SAMPLE.TIME] = r.t ?? k;
    data[o + SAMPLE.RPM] = r.rpm ?? 10000;
    data[o + SAMPLE.LINE] = r.line ?? 0;
    data[o + SAMPLE.MOTION] = r.rapid ? MOTION_RAPID : 0;
    data[o + SAMPLE.TOOL] = r.tool ?? 1;
    data.set([r.p[0], r.p[1], r.p[2] + tipLength], o + SAMPLE.AXES);
  });
  return [data, rows.length, stride];
}

const kinds = (cutter) => cutter.findings.map((f) => `${f.kind}@${f.line}`).sort();

test('cutting on a feed move is fine; on a rapid, or with the spindle off, it is not', () => {
  const c = new Cutter(box, { resolution: 0.1, tools: { 1: { diameter: 6, length: 30, fluteLength: 20 } }, tipLength: 30 });
  c.addSamples(...samples([
    { p: [5, 10, 12], line: 1 },
    { p: [5, 10, 9], line: 2 },                    // plunge on a feed move
    { p: [15, 10, 9], line: 3 },
    { p: [25, 10, 9], line: 4, rapid: true },      // rapid through material
    { p: [35, 10, 9], line: 5, rpm: 0 },           // spindle off
  ]));
  assert.deepEqual(kinds(c), ['rapid@4', 'spindle@5']);
  const rapid = c.findings.find((f) => f.kind === 'rapid');
  near(rapid.depth, 1, 1e-4);
  assert.equal(rapid.severity, 'error');
  assert.ok(c.stats.removed > 0);
});

test('material above the flutes hits the shank; above the stick-out, the collet nut', () => {
  const tools = { 1: { diameter: 6, length: 30, fluteLength: 2 }, 2: { diameter: 6, length: 5, fluteLength: 5 } };
  const c = new Cutter(box, { resolution: 0.1, tools, tipLength: 30 });
  c.addSamples(...samples([
    { p: [5, 5, 12], line: 1 },
    { p: [5, 5, 6], line: 2 },                     // plunging: the flutes cut their way down
    { p: [15, 5, 6], line: 3 },                    // 4 deep sideways: 2 above the flutes
    { p: [30, 5, 12], line: 4, tool: 2 },
    { p: [30, 5, 3], line: 5, tool: 2 },           // 7 deep with 5 sticking out
  ]));
  assert.deepEqual(kinds(c), ['holder@5', 'shank@3']);
  near(c.findings.find((f) => f.kind === 'shank').depth, 10 - (6 + 2), 1e-4);
});

test('the tip going below the table is a warning; repeats on a line are counted', () => {
  const c = new Cutter(box, { resolution: 0.2, tool: { diameter: 3, length: 20 }, tipLength: 20 });
  c.addSamples(...samples([
    { p: [60, 5, 5], line: 1, tool: 0 },
    { p: [60, 5, -0.5], line: 2, tool: 0 },
    { p: [60, 10, -0.5], line: 2, tool: 0 },
    { p: [60, 10, -0.3], line: 2, tool: 0 },
  ], 20));
  assert.deepEqual(kinds(c), ['table@2']);
  assert.equal(c.findings[0].severity, 'warning');
  assert.equal(c.findings[0].count, 1);   // one stretch below the table, however many samples
  assert.deepEqual(c.takeFindings()?.length, 1);
  assert.equal(c.takeFindings(), null);
});
