// SPDX-License-Identifier: LGPL-3.0-or-later
// The whole path: the firmware runs a program (tools/run-headless.mjs), its
// samples cut the stock and the findings point at the right lines. Needs the
// firmware built into web/src/firmware; skipped otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const built = existsSync(join(root, 'web/src/firmware/grblhal-jspi.wasm'));

// A fresh controller powers on with its collet face at physical (100, 100, 180)
// = MPos 0. Work zero goes on the stock's top, 5 mm in from its front left corner:
// tip (5, 5, 10), collet face (5, 5, 32), so G54 = (-95, -95, -148).
const fixture = {
  toolLength: 22,
  stock: { min: [0, 0, 0], max: [90, 70, 10] },
  tool: { diameter: 3.175, length: 22, fluteLength: 12 },
};

function simulate(program) {
  const dir = mkdtempSync(join(tmpdir(), 'grblhal-sim-'));
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture));
  const report = join(dir, 'report.json');
  let status = 0;
  try {
    execFileSync(process.execPath, [join(root, 'tools/run-headless.mjs'), '-f', join(dir, 'fixture.json'), '-r', report,
      '-c', 'G10 L2 P1 X-95 Y-95 Z-148', program], { stdio: 'pipe' });
  } catch (err) {
    status = err.status;
  }
  return { status, ...JSON.parse(readFileSync(report, 'utf8')) };
}

test('collisions are found on the lines that cause them', { skip: !built && 'firmware not built' }, () => {
  const { status, findings, stats } = simulate(join(root, 'web/test/fixtures/collisions.nc'));
  assert.equal(status, 3, 'exit status 3: there are errors');
  const got = findings.map((f) => `${f.kind}@${f.line}`).sort();
  assert.deepEqual(got, ['rapid@8', 'shank@18', 'spindle@12', 'spindle@13', 'table@17', 'table@18', 'table@19']);
  const rapid = findings.find((f) => f.kind === 'rapid');
  assert.ok(Math.abs(rapid.depth - 2) < 0.01, `rapid depth ${rapid.depth}`);
  // The rapid's deepest point is in the stock, at work Z-2: physical tip Z 8.
  assert.ok(Math.abs(rapid.at[2] - 8) < 0.01, `rapid at ${rapid.at}`);
  assert.ok(stats.removed > 500 && stats.removed < 1500, `removed ${stats.removed} mm³`);
});
