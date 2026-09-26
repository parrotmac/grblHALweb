// SPDX-License-Identifier: LGPL-3.0-or-later
// Host side of the grblHAL wasm simulator: owns the serial queues, position
// samples and NVS persistence that the firmware exchanges with the host at
// each yield (see src/sim.c). Runs the firmware on the calling thread; see
// GrblHALWorker (worker-client.js) to run it in a Web Worker instead.

import { loadFirmware } from './firmware.js';
import { serialOutput, toBytes } from './output.js';

export class GrblHAL {
  #input = [];            // pending bytes to the firmware
  #output = serialOutput(this);
  #stopRequested = false;
  #stopped = null;        // resolves once the firmware has seen the stop request
  #markStopped = null;

  speed = 1;              // simulated seconds per wall second, 0 = as fast as possible
  simTime = 0;            // simulated seconds at the last yield
  simTimeWall = 0;        // performance.now() when simTime was reported
  variant = null;         // 'jspi' | 'asyncify' once started

  // Callbacks
  onBytes = null;         // (Uint8Array) raw serial output
  onData = null;          // (text) serial output, decoded
  onLine = null;          // (line) complete output lines, without "\r\n"
  onSamples = null;       // (Float64Array data, count, stride), see SAMPLE in index.js
  onClock = null;         // (seconds) simulated time, reported at every yield
  onCrash = null;         // (error) the firmware trapped or aborted
  nvsLoad = null;         // (Uint8Array dest) => bool, fill dest with saved NVS contents
  nvsSave = null;         // (Uint8Array data)

  constructor(options = {}) {
    Object.assign(this, options);
  }

  // Boots the firmware. Resolves once it is running; callbacks may fire before
  // that. `factory` defaults to the build this engine supports (loadFirmware()).
  async start(factory, moduleArgs = {}) {
    if (!factory) ({ factory, variant: this.variant } = await loadFirmware());
    this.module = await factory({ host: this.#hostInterface(), ...moduleArgs });
    // grblHAL's main() never returns. Under JSPI callMain() returns a promise that
    // settles when the firmware stops; under Asyncify it returns at the first yield.
    Promise.resolve()
      .then(() => this.module.callMain([]))
      .catch((err) => (this.onCrash ? this.onCrash(err) : console.error('grblHAL crashed:', err)));
    return this;
  }

  // Stops the firmware at its next yield (at most ~16 ms of wall time away).
  // NVS changes are saved first. The instance cannot be restarted.
  stop() {
    if (!this.#stopped) {
      this.#stopRequested = true;
      this.#stopped = new Promise((resolve) => (this.#markStopped = resolve));
    }
    return this.#stopped;
  }

  // Queue text or bytes for the simulated UART.
  write(data) {
    for (const b of toBytes(data)) this.#input.push(b);
  }

  // Realtime commands bypass nothing on real hardware either, they just go down the wire.
  realtime(byte) {
    this.#input.push(byte);
  }

  get inputPending() {
    return this.#input.length;
  }

  #hostInterface() {
    return {
      serialRead: (dest) => {
        const n = Math.min(dest.length, this.#input.length);
        for (let i = 0; i < n; i++) dest[i] = this.#input[i];
        this.#input.splice(0, n);
        return n;
      },
      serialWrite: (bytes) => this.#output(bytes),
      samples: (data, count, stride) => this.onSamples?.(data, count, stride),
      nvsLoad: (dest) => this.nvsLoad?.(dest) ?? false,
      nvsSave: (data) => this.nvsSave?.(data),
      speed: () => this.speed,
      clock: (seconds) => {
        this.simTime = seconds;
        this.simTimeWall = performance.now();
        this.onClock?.(seconds);
      },
      stopRequested: () => {
        if (this.#stopRequested) queueMicrotask(this.#markStopped);
        return this.#stopRequested;
      },
    };
  }
}
