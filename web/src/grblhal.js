// Host side of the grblHAL wasm simulator: owns the serial queues, position
// samples and NVS persistence that the firmware exchanges with the host at
// each yield (see src/sim.c). Works in browsers and Node.

export class GrblHAL {
  #input = [];            // pending bytes to the firmware
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #lineBuf = '';

  speed = 1;              // simulated seconds per wall second, 0 = as fast as possible
  simTime = 0;            // simulated seconds at the last yield
  simTimeWall = 0;        // performance.now() when simTime was reported

  // Callbacks
  onData = null;          // (text) raw serial output
  onLine = null;          // (line) complete output lines, without "\r\n"
  onSamples = null;       // (Float64Array data, count, stride)
  nvsLoad = null;         // (Uint8Array dest) => bool, fill dest with saved NVS contents
  nvsSave = null;         // (Uint8Array data)

  constructor(options = {}) {
    Object.assign(this, options);
  }

  onCrash = null;         // (error) the firmware trapped or aborted

  // Boots the firmware. Resolves once it is running; callbacks may fire before that.
  async start(factory, moduleArgs = {}) {
    this.module = await factory({ host: this.#hostInterface(), ...moduleArgs });
    // grblHAL's main() never returns. Under JSPI callMain() returns a promise that
    // only settles if it traps; under Asyncify it returns at the first yield.
    Promise.resolve()
      .then(() => this.module.callMain([]))
      .catch((err) => (this.onCrash ? this.onCrash(err) : console.error('grblHAL crashed:', err)));
    return this;
  }

  // Queue text or bytes for the simulated UART.
  write(data) {
    const bytes = typeof data === 'string' ? this.#encoder.encode(data) : data;
    for (const b of bytes) this.#input.push(b);
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
      serialWrite: (bytes) => {
        const text = this.#decoder.decode(bytes, { stream: true });
        this.onData?.(text);
        if (this.onLine) {
          this.#lineBuf += text;
          let i;
          while ((i = this.#lineBuf.indexOf('\n')) >= 0) {
            this.onLine(this.#lineBuf.slice(0, i).replace(/\r$/, ''));
            this.#lineBuf = this.#lineBuf.slice(i + 1);
          }
        }
      },
      samples: (data, count, stride) => this.onSamples?.(data, count, stride),
      nvsLoad: (dest) => this.nvsLoad?.(dest) ?? false,
      nvsSave: (data) => this.nvsSave?.(data),
      speed: () => this.speed,
      clock: (seconds) => {
        this.simTime = seconds;
        this.simTimeWall = performance.now();
      },
    };
  }
}
