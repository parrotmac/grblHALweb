// Web Worker entry point: runs the firmware off the main thread for
// GrblHALWorker (worker-client.js). Everything the firmware hands over at a
// yield - serial output, position samples, the simulated clock - goes back to
// the page as one 'yield' message.
//
// Page -> worker: start { variant, speed, nvs, samples }, input { bytes },
//                 speed { value }, stop
// Worker -> page: ready { variant }, yield { time, bytes?, samples? }, nvs { data },
//                 crash { message }, stopped

import { GrblHAL } from './grblhal.js';
import { loadFirmware } from './firmware.js';

let sim = null;
const early = [];       // input that arrived before the firmware was loaded
let bytes = [];
let samples = [];
let stride = 0;

function concat(chunks, Type) {
  if (chunks.length === 1) return chunks[0];
  const out = new Type(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function flush(time) {
  const msg = { type: 'yield', time };
  const transfer = [];
  if (bytes.length) {
    msg.bytes = concat(bytes, Uint8Array);
    transfer.push(msg.bytes.buffer);
    bytes = [];
  }
  if (samples.length) {
    msg.samples = concat(samples, Float64Array);
    msg.count = msg.samples.length / stride;
    msg.stride = stride;
    transfer.push(msg.samples.buffer);
    samples = [];
  }
  postMessage(msg, transfer);
}

async function start({ variant, speed, nvs, samples: wantSamples }) {
  const loaded = await loadFirmware(variant);
  sim = new GrblHAL({
    speed,
    variant: loaded.variant,
    onBytes: (b) => bytes.push(b), // already a copy of wasm memory
    onSamples: wantSamples
      ? (data, count, s) => {
          stride = s;
          samples.push(data);
        }
      : null,
    onClock: flush,
    onCrash: (err) => postMessage({ type: 'crash', message: String(err?.message ?? err) }),
    nvsLoad: (dest) => {
      if (!nvs) return false;
      dest.set(nvs.subarray(0, dest.length));
      return true;
    },
    nvsSave: (data) => postMessage({ type: 'nvs', data }, [data.buffer]),
  });
  for (const b of early.splice(0)) sim.write(b);
  await sim.start(loaded.factory);
  postMessage({ type: 'ready', variant: loaded.variant });
}

self.onmessage = async ({ data: msg }) => {
  switch (msg.type) {
    case 'start':
      try {
        await start(msg);
      } catch (err) {
        postMessage({ type: 'crash', message: `could not start the firmware: ${err?.message ?? err}` });
      }
      break;
    case 'input':
      if (sim) sim.write(msg.bytes);
      else early.push(msg.bytes);
      break;
    case 'speed':
      if (sim) sim.speed = msg.value;
      break;
    case 'stop':
      await sim?.stop();
      postMessage({ type: 'stopped' });
      break;
  }
};
