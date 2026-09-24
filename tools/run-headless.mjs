#!/usr/bin/env node
// Headless runner: boots the wasm firmware under Node, streams G-code/commands
// to it line by line (waiting for ok/error like a sender would), prints the
// responses and exits once everything has been acknowledged and motion stopped.
//
//   node tools/run-headless.mjs [-t speed] [-e nvs.bin] [-s samples.csv] [file.nc | -c "cmd" ...]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GrblHAL } from '../web/src/grblhal.js';
import createGrblHAL from '../build/grblhal-jspi.mjs';

const args = process.argv.slice(2);
let speed = 0, nvsFile = null, samplesFile = null;
const lines = [];

while (args.length) {
  const a = args.shift();
  if (a === '-t') speed = parseFloat(args.shift());
  else if (a === '-e') nvsFile = args.shift();
  else if (a === '-s') samplesFile = args.shift();
  else if (a === '-c') lines.push(args.shift());
  else lines.push(...readFileSync(a, 'utf8').split(/\r?\n/));
}

const queue = lines.map((l) => l.trim()).filter((l) => l.length);
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
  onLine(line) {
    console.log(line);
    if (!booted && line.startsWith('GrblHAL')) booted = true;
    if (line === 'ok' || line.startsWith('error')) waiting = false;
    if (booted) sendNext();
  },
  onSamples(data, count, stride) {
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
await sim.start(createGrblHAL);


// Done when every line is acknowledged and the machine has reported idle for a while.
const timer = setInterval(() => {
  if (!booted) return;
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
    const axes = ['x', 'y', 'z', 'a', 'b', 'c'].slice(0, ((csv[0]?.split(',').length ?? 11) - 5) / 2);
    const header = ['t', 'state', 'rpm', 'coolant', 'homed', ...axes, ...axes.map((a) => `m${a}`)];
    writeFileSync(samplesFile, header.join(',') + '\n' + csv.join('\n') + '\n');
  }
  process.exit(0);
}
