// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Embedder side of the grblHAL simulator's postMessage API (PROTOCOL.md).
// No dependencies: import it from the app (`<app>/client.js`) or copy it.
//
//   import { connect } from 'https://example.com/grblhal/client.js';
//
//   const iframe = document.querySelector('iframe');  // src = the app
//   const sim = await connect(iframe.contentWindow);  // or a window.open() handle
//   sim.onLine = (line) => console.log(line);
//   sim.write('$$\n');
//   sim.realtime(0x3f);                                // '?'

export const PROTOCOL = 1;

// The app's origin when this file is loaded from the app itself.
const HOME = (() => {
  try {
    const { origin } = new URL(import.meta.url);
    return origin.startsWith('http') ? origin : null;
  } catch {
    return null;
  }
})();

export class GrblHALClient {
  #port;
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #lineBuf = '';
  #speed;
  #closed = false;

  variant;                // 'jspi' | 'asyncify' once the firmware runs
  running;                // the firmware is booted
  simTime = 0;            // simulated seconds at the last yield
  source;                 // { repo, commit, dirty, core } the app was built from

  // Callbacks
  onBytes = null;         // (Uint8Array) raw serial output
  onData = null;          // (text) serial output, decoded
  onLine = null;          // (line) complete output lines, without "\r\n"
  onClock = null;         // (seconds) simulated time, about 60 times a second
  onSamples = null;       // (Float64Array data, count, stride) with connect({ samples: true })
  onSpeed = null;         // (value) the speed was changed in the app
  onStarted = null;       // (variant) the firmware (re)booted
  onCrash = null;         // (message) the firmware trapped or failed to load
  onClose = null;         // (reason) the connection ended

  constructor(port, hello) {
    this.#port = port;
    this.#speed = hello.speed;
    this.variant = hello.variant;
    this.running = hello.running;
    this.source = hello.source;
    port.onmessage = ({ data }) => this.#receive(data);
  }

  get closed() {
    return this.#closed;
  }

  /** Simulated seconds per wall second; 0 = as fast as possible. */
  get speed() {
    return this.#speed;
  }

  set speed(value) {
    this.#speed = value;
    this.#post({ type: 'speed', value });
  }

  /** Queues text or bytes for the controller's serial input. */
  write(data) {
    this.#post({ type: 'write', data: typeof data === 'string' ? data : new Uint8Array(data) });
  }

  /** Sends one realtime command byte, e.g. 0x3f ('?'), 0x21 ('!'), 0x7e ('~'), 0x18 (reset). */
  realtime(byte) {
    this.#post({ type: 'realtime', byte: typeof byte === 'string' ? byte.charCodeAt(0) : byte });
  }

  /** Shows a program preview in the app's machine view; null clears it. */
  showProgram(text, name) {
    this.#post({ type: 'program', text, name });
  }

  /** Power cycles the controller; `factory` erases its saved settings first. */
  reboot({ factory = false } = {}) {
    this.running = false;
    this.#post({ type: 'reboot', factory });
  }

  /** Hands the serial link back to the app. */
  close() {
    this.#post({ type: 'disconnect' });
    this.#end('closed');
  }

  #post(msg) {
    if (!this.#closed) this.#port.postMessage(msg);
  }

  #end(reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.close();
    this.onClose?.(reason);
  }

  #receive(msg) {
    switch (msg?.type) {
      case 'serial':
        this.#output(msg.bytes);
        break;
      case 'clock':
        this.simTime = msg.time;
        this.onClock?.(msg.time);
        break;
      case 'samples':
        this.onSamples?.(msg.data, msg.count, msg.stride);
        break;
      case 'speed':
        this.#speed = msg.value;
        this.onSpeed?.(msg.value);
        break;
      case 'started':
        this.running = true;
        this.variant = msg.variant;
        this.onStarted?.(msg.variant);
        break;
      case 'crashed':
        this.running = false;
        this.onCrash?.(msg.message);
        break;
      case 'disconnected':
        this.#end(msg.reason);
        break;
    }
  }

  #output(bytes) {
    this.onBytes?.(bytes);
    if (!this.onData && !this.onLine) return;
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
  }
}

/**
 * Connects to the simulator app in `target`: an iframe's contentWindow, or a
 * window from window.open() (without 'noopener'). Waits for the app to load.
 *
 * options.origin   the app's origin; defaults to where this file was loaded from
 * options.samples  also deliver position samples (onSamples)
 * options.timeout  ms to wait for the app, default 30000
 */
export function connect(target, { origin = HOME, samples = false, timeout = 30000 } = {}) {
  if (!origin) return Promise.reject(new Error('connect: pass options.origin, the origin the app is served from'));

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, client) => {
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
      err ? reject(err) : resolve(client);
    };
    const timer = setTimeout(() => finish(new Error('connect: the app did not answer')), timeout);

    // The app announces itself when it loads, and answers 'hello' if it
    // already has. Connect on the first announcement only.
    function onReady(e) {
      if (done || e.source !== target || e.origin !== origin || e.data?.grblhal !== 'ready') return;
      window.removeEventListener('message', onReady);
      if (e.data.protocol !== PROTOCOL) {
        return finish(new Error(`connect: the app speaks protocol ${e.data.protocol}, this client ${PROTOCOL}`));
      }

      const { port1, port2 } = new MessageChannel();
      port1.onmessage = ({ data }) => {
        if (data?.type === 'connected') finish(null, new GrblHALClient(port1, data));
        else if (data?.type === 'error' || data?.type === 'disconnected') {
          port1.close();
          finish(new Error(`connect: ${data.message ?? data.reason}`));
        }
      };
      target.postMessage({ grblhal: 'connect', protocol: PROTOCOL, samples }, origin, [port2]);
    }
    window.addEventListener('message', onReady);

    // An app that is still loading announces itself once it runs; one that
    // already has answers this. (Until the app's page is there, the message is
    // not delivered: it is addressed to the app's origin.)
    target.postMessage({ grblhal: 'hello' }, origin);
  });
}
