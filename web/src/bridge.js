// SPDX-License-Identifier: LGPL-3.0-or-later
//
// The app's postMessage API: another page (the parent of an iframe, or the
// opener of a window) connects with a MessagePort and then drives the
// simulated serial link over it. The protocol is documented in PROTOCOL.md;
// public/client.js is the embedder side.
//
// Handshake, as window messages (the `grblhal` field is the message type):
//   app -> parent/opener   { grblhal: 'ready', protocol }        on load, and in reply to 'hello'
//   embedder -> app        { grblhal: 'hello' }                  optional probe
//   embedder -> app        { grblhal: 'connect', protocol, samples } + a MessagePort
// Everything after that goes over the port. One client at a time: a new
// connect replaces the current one, which is sent 'disconnected'.

export const PROTOCOL = 1;

export class Bridge {
  #port = null;

  origin = null;          // the connected client's origin
  samples = false;        // the client wants position samples

  // Callbacks
  onConnect = null;       // (origin) a client connected
  onDisconnect = null;    // () the client went away
  onMessage = null;       // (msg) a message from the client

  get connected() {
    return !!this.#port;
  }

  listen() {
    window.addEventListener('message', (e) => this.#onWindowMessage(e));
    window.addEventListener('pagehide', () => this.#close('app closed'));
    // Whoever embedded or opened us may be waiting for this. It carries no
    // data, so any origin may see it.
    const host = window.parent !== window ? window.parent : window.opener;
    host?.postMessage({ grblhal: 'ready', protocol: PROTOCOL }, '*');
  }

  send(msg, transfer) {
    this.#port?.postMessage(msg, transfer);
  }

  disconnect(reason = 'closed by the app') {
    this.#close(reason);
  }

  #onWindowMessage(e) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.grblhal !== 'string' || !e.source) return;

    if (msg.grblhal === 'hello') {
      // Opaque origins (sandboxed frames, file://) can only be targeted with '*'.
      e.source.postMessage({ grblhal: 'ready', protocol: PROTOCOL }, e.origin === 'null' ? '*' : e.origin);
      return;
    }
    if (msg.grblhal !== 'connect') return;

    const port = e.ports[0];
    if (!port) return;
    if (msg.protocol !== PROTOCOL) {
      port.postMessage({ type: 'error', message: `unsupported protocol ${msg.protocol}, this app speaks ${PROTOCOL}` });
      port.close();
      return;
    }

    this.#close('another client connected');
    this.#port = port;
    this.origin = e.origin;
    this.samples = !!msg.samples;
    port.onmessage = ({ data }) => {
      if (data?.type === 'disconnect') this.#close(null);
      else if (data && typeof data.type === 'string') this.onMessage?.(data);
    };
    this.onConnect?.(this.origin);
  }

  #close(reason) {
    const port = this.#port;
    if (!port) return;
    this.#port = null;
    if (reason) port.postMessage({ type: 'disconnected', reason });
    port.close();
    this.origin = null;
    this.samples = false;
    this.onDisconnect?.();
  }
}
