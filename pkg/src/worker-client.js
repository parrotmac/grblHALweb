// Runs the firmware in a dedicated Web Worker, with the same surface as
// GrblHAL: nothing on the page's main thread slows simulated time, and stop()
// ends with worker.terminate().

import { serialOutput, toBytes } from './output.js';

const NVS_SIZE = 4096; // SIM_NVS_SIZE in src/sim.h
const STOP_GRACE_MS = 1000;

export class GrblHALWorker {
  #worker = null;
  #output = serialOutput(this);
  #speed = 1;
  #stopped = null;
  #onStopped = null;
  #pending = [];          // input written before start()

  simTime = 0;            // simulated seconds at the last yield
  simTimeWall = 0;        // performance.now() when simTime arrived
  variant = null;         // 'jspi' | 'asyncify' once started

  // Options
  firmware = 'auto';      // 'auto' | 'jspi' | 'asyncify'
  samples = false;        // deliver position samples (onSamples)

  // Callbacks, as for GrblHAL
  onBytes = null;
  onData = null;
  onLine = null;
  onSamples = null;
  onClock = null;
  onCrash = null;
  nvsLoad = null;         // called once, before the firmware boots
  nvsSave = null;

  constructor(options = {}) {
    const { speed, ...rest } = options;
    Object.assign(this, rest);
    if (speed !== undefined) this.#speed = speed;
  }

  get speed() {
    return this.#speed;
  }

  set speed(value) {
    this.#speed = value;
    this.#worker?.postMessage({ type: 'speed', value });
  }

  // Boots the firmware in a new worker; resolves once it is running.
  start() {
    if (this.#worker) return Promise.reject(new Error('already started'));

    const nvs = new Uint8Array(NVS_SIZE);
    const hasNvs = !!this.nvsLoad?.(nvs);

    // Bundlers (Vite, webpack, Parcel) recognise this exact pattern and emit the worker.
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'grblHAL' });
    this.#worker = worker;

    return new Promise((resolve, reject) => {
      let running = false;
      const crash = (err) => {
        if (!running) return reject(err);
        if (this.onCrash) this.onCrash(err);
        else console.error('grblHAL crashed:', err);
      };

      worker.onmessage = ({ data: msg }) => {
        switch (msg.type) {
          case 'ready':
            running = true;
            this.variant = msg.variant;
            resolve(this);
            break;
          case 'yield':
            this.simTime = msg.time;
            this.simTimeWall = performance.now();
            if (msg.bytes) this.#output(msg.bytes);
            if (msg.samples) this.onSamples?.(msg.samples, msg.count, msg.stride);
            this.onClock?.(msg.time);
            break;
          case 'nvs':
            this.nvsSave?.(msg.data);
            break;
          case 'crash':
            crash(new Error(msg.message));
            break;
          case 'stopped':
            this.#onStopped?.();
            break;
        }
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        crash(new Error(e.message || 'grblHAL worker failed to load'));
      };

      worker.postMessage({
        type: 'start',
        variant: this.firmware,
        speed: this.#speed,
        nvs: hasNvs ? nvs : null,
        samples: this.samples && !!this.onSamples,
      });
      for (const bytes of this.#pending.splice(0)) worker.postMessage({ type: 'input', bytes }, [bytes.buffer]);
    });
  }

  // Stops the firmware (after saving NVS changes) and terminates the worker.
  stop() {
    if (this.#stopped) return this.#stopped;
    const worker = this.#worker;
    if (!worker) return (this.#stopped = Promise.resolve());

    this.#stopped = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        worker.terminate();
        resolve();
      };
      const timer = setTimeout(done, STOP_GRACE_MS);
      this.#onStopped = done;
      worker.postMessage({ type: 'stop' });
    });
    return this.#stopped;
  }

  // Queue text or bytes for the simulated UART.
  write(data) {
    const bytes = toBytes(data).slice();
    if (this.#worker) this.#worker.postMessage({ type: 'input', bytes }, [bytes.buffer]);
    else if (!this.#stopped) this.#pending.push(bytes);
  }

  realtime(byte) {
    this.write(Uint8Array.of(byte));
  }
}
