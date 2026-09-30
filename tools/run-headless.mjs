#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
// Headless runner: boots the wasm firmware under Node, streams G-code/commands
// to it line by line (waiting for ok/error like a sender would), prints the
// responses and exits once everything has been acknowledged and motion stopped.
// It resumes (cycle start) after tool changes and M0/M1 pauses.
//
//   node tools/run-headless.mjs [-t speed] [-e nvs.bin] [-s samples.csv] [-f fixture.json]
//                               [-r report.json] [-m heightmap.pgm] [file.nc | -c "cmd" ...]
//
// -f sets the fixture (tool length, stock box, touch plate), as JSON:
// { "toolLength": 20, "stock": { "min": [x, y, z], "max": [x, y, z] }, "plate": 0 }
// With a stock, it may also have "tool" (the tool in the collet) and "tools"
// (a table by T number) for stock simulation (see PROTOCOL.md).
//
// -r simulates the stock: every line of the program files is numbered with
// its line (N words), the tool's path cuts the stock and collisions are
// written as JSON ({ stats, findings }). The exit status is 3 if there are
// errors among them. -m also writes the cut stock as a 16-bit PGM heightmap
// (black = the stock's bottom, white = its top, first row at the back).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GrblHAL, loadFirmware, SAMPLE } from '../web/src/sim/index.js';
import { Cutter } from '../web/src/stock/cutter.js';

const args = process.argv.slice(2);
let speed = 0, nvsFile = null, samplesFile = null, fixture = null, reportFile = null, heightmapFile = null;
const lines = [];                 // { text, source }: source is the line in its file, 0 for -c

while (args.length) {
  const a = args.shift();
  if (a === '-t') speed = parseFloat(args.shift());
  else if (a === '-e') nvsFile = args.shift();
  else if (a === '-s') samplesFile = args.shift();
  else if (a === '-f') fixture = JSON.parse(readFileSync(args.shift(), 'utf8'));
  else if (a === '-r') reportFile = args.shift();
  else if (a === '-m') heightmapFile = args.shift();
  else if (a === '-c') lines.push({ text: args.shift(), source: 0 });
  else lines.push(...readFileSync(a, 'utf8').split(/\r?\n/).map((text, i) => ({ text, source: i + 1 })));
}

const simulateStock = !!(reportFile || heightmapFile);
if (simulateStock && !fixture?.stock) {
  console.error('-r and -m need a stock: -f fixture.json with "stock": { "min": [x, y, z], "max": [x, y, z] }');
  process.exit(1);
}
const tool = fixture?.tool ?? { diameter: 3.175, length: fixture?.toolLength ?? 22 };
const cutter = simulateStock
  ? new Cutter(fixture.stock, { resolution: fixture.resolution, tools: fixture.tools, tool, tipLength: fixture.toolLength ?? tool.length })
  : null;

// Program lines numbered like the app's simulation does, so findings point at them.
const queue = lines
  .map(({ text, source }) => {
    const line = text.replace(/\(.*?\)|;.*$/g, '').trim();
    if (!cutter || !source || !line || line.startsWith('$') || line === '%') return line;
    const rest = line.replace(/^N\s*\d+\s*/i, '');
    return rest && `N${source} ${rest}`;
  })
  .filter((l) => l && l !== '%');
const csv = [];
let lastState = 0, waiting = false, booted = false, finished = false, idleSince = 0;

function sendNext() {
  if (waiting || !queue.length) return;
  const line = queue.shift();
  console.log(`> ${line}`);
  sim.write(line + '\n');
  waiting = true;
}

const sim = new GrblHAL({
  speed,
  samplePeriod: samplesFile ? 1 : 0, // the stock only needs the corners
  onLine(line) {
    console.log(line);
    // Like an operator: resume after a tool change or a program pause (M0/M1).
    if (line.startsWith('<Tool|') || line.startsWith('<Hold:0|')) sim.realtime(0x7e);
    if (!booted && line.startsWith('GrblHAL')) booted = true;
    if (line === 'ok' || line.startsWith('error')) waiting = false;
    if (booted) sendNext();
  },
  onSamples(data, count, stride) {
    cutter?.addSamples(data, count, stride);
    for (let i = 0; i < count; i++) {
      const s = data.subarray(i * stride, (i + 1) * stride);
      if (samplesFile) csv.push(Array.from(s, (v, j) => (j === 0 ? v.toFixed(6) : +v.toFixed(4))).join(','));
      lastState = s[1];
    }
  },
  nvsLoad(dest) {
    if (!nvsFile || !existsSync(nvsFile)) return false;
    dest.set(readFileSync(nvsFile).subarray(0, dest.length));
    return true;
  },
  nvsSave(data) {
    if (nvsFile) writeFileSync(nvsFile, data);
  },
});
if (fixture) sim.fixture = { ...fixture, toolLength: fixture.toolLength ?? tool.length };
await sim.start((await loadFirmware('jspi')).factory);


// Done when every line is acknowledged and the machine has reported idle for a while.
let polls = 0;
const timer = setInterval(() => {
  if (!booted) return;
  // Status while lines are outstanding, to see tool changes and pauses.
  if ((queue.length || waiting) && ++polls % 4 === 0) sim.realtime(0x3f);
  if (!queue.length && !waiting && lastState === 0 /* STATE_IDLE */ && !sim.inputPending) {
    if (!idleSince) {
      idleSince = Date.now();
      sim.write('?'); // flush one last status report
    } else if (Date.now() - idleSince > 300) finish();
  } else idleSince = 0;
}, 50);

function finish() {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (samplesFile) {
    const axes = ['x', 'y', 'z', 'a', 'b', 'c'].slice(0, ((csv[0]?.split(',').length ?? 14) - SAMPLE.AXES) / 2);
    const header = ['t', 'state', 'rpm', 'coolant', 'homed', 'line', 'motion', 'tool', ...axes, ...axes.map((a) => `m${a}`)];
    writeFileSync(samplesFile, header.join(',') + '\n' + csv.join('\n') + '\n');
  }
  if (cutter) {
    const { stats, findings } = cutter;
    for (const f of findings) console.error(`${f.severity}: line ${f.line}: ${f.message}${f.count > 1 ? ` (${f.count}×)` : ''}`);
    console.error(`stock: ${(stats.removed / 1000).toFixed(2)} cm³ removed, ${stats.errors} errors, ${stats.warnings} warnings`);
    if (reportFile) writeFileSync(reportFile, JSON.stringify({ stats, findings }, null, 2) + '\n');
    if (heightmapFile) writeFileSync(heightmapFile, heightmap(cutter.stock));
    process.exit(stats.errors ? 3 : 0);
  }
  process.exit(0);
}

// 16-bit binary PGM, top row = the back (max Y) of the stock.
function heightmap(stock) {
  const { nx, ny, z, top, bottom } = stock;
  const header = Buffer.from(`P5\n${nx} ${ny}\n65535\n`);
  const body = Buffer.alloc(nx * ny * 2);
  const span = Math.max(top - bottom, 1e-9);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = Math.round(Math.min(1, Math.max(0, (z[j * nx + i] - bottom) / span)) * 65535);
      body.writeUInt16BE(v, ((ny - 1 - j) * nx + i) * 2);
    }
  }
  return Buffer.concat([header, body]);
}
