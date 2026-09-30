// SPDX-License-Identifier: LGPL-3.0-or-later
// Web Worker entry point: runs a Cutter (stock removal and collision checks)
// off the main thread, for StockWorker (client.js).
//
// Page -> worker: init { box, resolution, tools, tool, tipLength }, tools { tools, tool, tipLength },
//                 samples { data, count, stride }, report { kind, line, message }, resend,
//                 flush { id }, export { id }, clear
// Worker -> page: model { model }, tiles { tiles }, findings { findings }, stats { stats },
//                 flushed { id }, exported { id, model, heights }

import { Cutter } from './cutter.js';

const SEND_INTERVAL_MS = 33;

let cutter = null;
let lastSend = 0;

function send(force = false) {
  if (!cutter) return;
  const now = performance.now();
  if (!force && now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;
  const tiles = cutter.stock.takeDirtyTiles();
  if (tiles.length) postMessage({ type: 'tiles', tiles }, tiles.map((t) => t.data.buffer));
  const findings = cutter.takeFindings();
  if (findings) postMessage({ type: 'findings', findings });
  postMessage({ type: 'stats', stats: cutter.stats });
}

self.onmessage = ({ data: msg }) => {
  switch (msg.type) {
    case 'init':
      cutter = new Cutter(msg.box, msg);
      postMessage({ type: 'model', model: cutter.stock.model });
      send(true);
      break;
    case 'tools':
      if (!cutter) break;
      cutter.setTools(msg.tools, msg.tool);
      if (msg.tipLength !== undefined) cutter.tipLength = msg.tipLength;
      break;
    case 'samples':
      if (!cutter) break;
      cutter.addSamples(msg.data, msg.count, msg.stride);
      send();
      break;
    case 'resend':
      if (!cutter) break;
      postMessage({ type: 'model', model: cutter.stock.model });
      cutter.stock.markAllDirty();
      send(true);
      break;
    case 'flush':
      send(true);
      postMessage({ type: 'flushed', id: msg.id });
      break;
    case 'export':
      postMessage({
        type: 'exported',
        id: msg.id,
        model: cutter?.stock.model ?? null,
        heights: cutter ? cutter.stock.z.slice() : null,
        findings: cutter?.findings ?? [],
        stats: cutter?.stats ?? null,
      });
      break;
    case 'report':
      cutter?.report(msg.kind, msg);
      send(true);
      break;
    case 'clear':
      cutter = null;
      break;
  }
};
