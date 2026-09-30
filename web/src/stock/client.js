// SPDX-License-Identifier: LGPL-3.0-or-later
// Main-thread side of the stock worker: a stock on the machine, cut by the
// position samples fed to it, reporting changed render tiles and findings.

export class StockWorker {
  #worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'stock' });
  #requests = new Map();
  #nextId = 1;
  #active = false;        // a stock was set up (init) and not cleared

  model = null;           // grid description, once initialised (see Stock.model)
  findings = [];
  stats = null;

  // Callbacks
  onModel = null;         // (model) a new stock
  onTiles = null;         // (tiles) changed render tiles, see Stock.takeDirtyTiles
  onFindings = null;      // (findings) the whole list, when it changed
  onStats = null;         // (stats)

  constructor() {
    this.#worker.onmessage = ({ data: msg }) => {
      switch (msg.type) {
        case 'model':
          if (!this.model) this.findings = [];
          this.model = msg.model;
          this.onModel?.(msg.model);
          break;
        case 'tiles':
          this.onTiles?.(msg.tiles);
          break;
        case 'findings':
          this.findings = msg.findings;
          this.onFindings?.(msg.findings);
          break;
        case 'stats':
          this.stats = msg.stats;
          this.onStats?.(msg.stats);
          break;
        case 'flushed':
        case 'exported':
          this.#requests.get(msg.id)?.(msg);
          this.#requests.delete(msg.id);
          break;
      }
    };
  }

  // A fresh stock. box: physical { min, max }; tools, tool, tipLength: see Cutter.
  init(box, { resolution, tools, tool, tipLength } = {}) {
    this.model = null;
    this.#active = true;
    this.#worker.postMessage({ type: 'init', box, resolution, tools, tool, tipLength });
  }

  setTools(tools, tool, tipLength) {
    this.#worker.postMessage({ type: 'tools', tools, tool, tipLength });
  }

  addSamples(data, count, stride) {
    if (this.#active) this.#worker.postMessage({ type: 'samples', data, count, stride });
  }

  // Firmware errors and alarms, attributed to a program line.
  report(kind, { line, message }) {
    this.#worker.postMessage({ type: 'report', kind, line, message });
  }

  clear() {
    this.#active = false;
    this.model = null;
    this.findings = [];
    this.#worker.postMessage({ type: 'clear' });
  }

  // Reports the model and every tile again, for a renderer starting over.
  resend() {
    this.#worker.postMessage({ type: 'resend' });
  }

  // Resolves once everything sent so far is processed and reported.
  flush() {
    return this.#request('flush');
  }

  // The whole heightfield: { model, heights (Float32Array, nx * ny, row by row from min y), findings, stats }.
  export() {
    return this.#request('export');
  }

  terminate() {
    this.#worker.terminate();
    for (const resolve of this.#requests.values()) resolve(null);
    this.#requests.clear();
  }

  #request(type) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#requests.set(id, resolve);
      this.#worker.postMessage({ type, id });
    });
  }
}
