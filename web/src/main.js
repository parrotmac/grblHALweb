// SPDX-License-Identifier: LGPL-3.0-or-later

import './style.css';
import { GrblHALWorker, jspiSupported, SAMPLE, toProtocolSamples } from './sim/index.js';
import { Sender } from './sender.js';
import { DEFAULT_TOOL, MachineViewer, parseGcode } from './viewer/index.js';
import { Bridge, PROTOCOL } from './bridge.js';
import { demoProgram, demoStock, machinePreset, PRESET_VERSION } from './demo.js';
import { StockWorker } from './stock/client.js';
import { normalizeTool, SHAPES } from './stock/tools.js';
import { Simulation } from './simulation.js';

const $ = (id) => document.getElementById(id);
const AXES = ['X', 'Y', 'Z'];
const NVS_KEY = 'grblhal-web:nvs';
const PRESET_KEY = 'grblhal-web:preset';
const TOOLS_KEY = 'grblhal-web:tools';
const STOCK_KEY = 'grblhal-web:stock';
const params = new URLSearchParams(location.search);

if (params.get('layout') === 'viewer') document.documentElement.dataset.layout = 'viewer';

const source = __SOURCE__;
if (source.commit) $('source').href = `${source.repo}/tree/${source.commit}`;
$('source').title = source.commit
  ? `grblHALweb ${source.commit.slice(0, 7)}${source.dirty ? ' (modified)' : ''}, grblHAL core ${source.core.slice(0, 7)}`
  : 'grblHALweb source';

// Scene colours follow the page's own tokens (style.css), in both schemes.
const viewer = new MachineViewer($('viewport'), {
  theme: {
    background: 'var(--viewport-bg)',
    grid: 'var(--grid)',
    gridMajor: 'var(--grid-major)',
    envelope: 'var(--envelope)',
    preview: 'var(--path-preview)',
    rapid: 'var(--path-rapid)',
    cut: 'var(--path-cut)',
    travel: 'var(--path-travel)',
  },
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => viewer.setTheme());

// --- Console -----------------------------------------------------------------

const log = $('log');
function print(text, kind = 'rx') {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = text;
  log.append(div);
  while (log.childElementCount > 600) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// --- Firmware ----------------------------------------------------------------

// Another page connected over postMessage (bridge.js) drives the serial link
// while it is connected; this page's own sender then only listens.
const bridge = new Bridge();
const sender = new Sender();
const firmware = params.get('firmware') ?? 'auto'; // ?firmware=asyncify to test the fallback
const VARIANT_NAMES = { jspi: 'JSPI', asyncify: 'Asyncify' };

let sim = null;
let speed = 1;
// What a client put on the machine: the tool, the stock and a touch plate
// (see the stock, tool and probe messages in PROTOCOL.md). Kept across reboots.
const fixture = { toolLength: DEFAULT_TOOL.length, stock: null, plate: 0 };
let freshNvs = false;
let latestNvs = null;   // the controller's settings as last saved, for simulations
let rateWindow = { t: 0, wall: performance.now() };

function loadNvs(dest) {
  try {
    const saved = localStorage.getItem(NVS_KEY);
    if (!saved) return (freshNvs = true, false);
    dest.set(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)).subarray(0, dest.length));
    latestNvs = dest.slice();
    return true;
  } catch {
    freshNvs = true;
    return false;
  }
}

function saveNvs(data) {
  latestNvs = data.slice();
  try {
    localStorage.setItem(NVS_KEY, btoa(String.fromCharCode(...data)));
  } catch {
    /* private mode: settings last for this session only */
  }
}

// Powers the controller up. The firmware runs in a Web Worker, so rendering
// never slows simulated time.
async function boot() {
  const instance = new GrblHALWorker({
    speed,
    samples: true,
    firmware,
    onSamples(data, count, stride) {
      liveStock.addSamples(data, count, stride);
      followTool(data[(count - 1) * stride + SAMPLE.TOOL]);
      viewer.addSamples(data, count, stride);
      if (bridge.samples) bridge.send({ type: 'samples', ...toProtocolSamples(data, count, stride) });
    },
    onBytes: (bytes) => bridge.send({ type: 'serial', bytes }),
    onClock: (time) => bridge.send({ type: 'clock', time }),
    nvsLoad: loadNvs,
    nvsSave: saveNvs,
    fixture: { ...fixture },
    onCrash(err) {
      print(`Firmware crashed: ${err?.message ?? err}`, 'error');
      bridge.send({ type: 'crashed', message: String(err?.message ?? err) });
      console.error(err);
    },
  });
  sim = instance;
  sender.attach(instance);
  if (import.meta.env.DEV) Object.assign(window, { sim: instance });

  $('variant').textContent = VARIANT_NAMES[firmware === 'auto' ? (jspiSupported ? 'jspi' : 'asyncify') : firmware];
  print(`Loading grblHAL (${$('variant').textContent} build)…`, 'note');
  try {
    await instance.start();
  } catch (err) {
    print(`Could not start the firmware: ${err.message}`, 'error');
    bridge.send({ type: 'crashed', message: `could not start the firmware: ${err.message}` });
    throw err;
  }
  $('variant').textContent = VARIANT_NAMES[instance.variant];
  bridge.send({ type: 'started', variant: instance.variant });
}

// Power cycle. `factory` also erases the saved settings.
async function reboot({ factory = false } = {}) {
  const old = sim;
  sim = null;
  sender.cancel();
  await old?.stop();
  if (factory) {
    try {
      localStorage.removeItem(NVS_KEY);
      localStorage.removeItem(PRESET_KEY); // re-apply the demo machine once the app drives again
    } catch {
      /* private mode */
    }
  }
  viewer.clearTrail();
  await boot();
}

function setSpeed(value) {
  speed = value;
  if (sim) sim.speed = value;
  for (const b of $('speed').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(parseFloat(b.dataset.speed) === value));
  }
}

if (import.meta.env.DEV) Object.assign(window, { viewer, sender, bridge }); // for poking at from devtools

sender.onLine = (text, kind) => print(text, text === 'ok' ? 'ok' : kind);

function presetApplied() {
  try {
    return localStorage.getItem(PRESET_KEY) === String(PRESET_VERSION);
  } catch {
    return false;
  }
}

sender.onReset = async () => {
  if (bridge.connected) return; // the client owns the controller, settings included
  if (freshNvs || !presetApplied()) {
    print(`${freshNvs ? 'Fresh controller' : 'Updated demo machine'}: applying the demo machine settings`, 'note');
    freshNvs = false;
    try {
      await Promise.all(machinePreset.map((cmd) => sender.send(cmd)));
    } catch {
      return; // cancelled, e.g. a client connected
    }
    try {
      localStorage.setItem(PRESET_KEY, String(PRESET_VERSION));
    } catch {
      /* private mode */
    }
    sender.stop(); // reboot so homing and limit settings take effect
    return;
  }
  sender.send('$$').catch(() => {});
};

sender.onSettings = (settings) => {
  if (viewer.applySettings(settings)) viewer.fit();
};

// --- Remote clients ----------------------------------------------------------

const decoder = new TextDecoder();

function setRemote(origin) {
  const remote = origin !== null;
  clientTools = {};
  apiTool = null;
  applyTools();
  $('remote').hidden = !remote;
  $('remote').textContent = remote ? `Driven by ${origin}` : '';
  $('remote').title = remote ? `${origin} is connected over postMessage and drives the serial link` : '';
  for (const el of $('panel').querySelectorAll('button, input, select')) el.disabled = remote;
  renderTools();
  updateProgramButtons();
  updateSimulationUi();
}

bridge.onConnect = (origin) => {
  sender.cancel();
  sender.stopPolling();
  setRemote(origin);
  print(`${origin} connected`, 'note');
  bridge.send({
    type: 'connected',
    protocol: PROTOCOL,
    running: !!sim?.variant,
    variant: sim?.variant ?? null,
    speed,
    source,
    features: FEATURES,
  });
};

bridge.onDisconnect = () => {
  setRemote(null);
  print('Client disconnected', 'note');
  sender.startPolling(5);
  sender.send('$$').catch(() => {});
};

bridge.onMessage = (msg) => {
  switch (msg.type) {
    case 'write':
      if (typeof msg.data === 'string' || msg.data instanceof Uint8Array) {
        sim?.write(msg.data);
        const text = typeof msg.data === 'string' ? msg.data : decoder.decode(msg.data);
        for (const line of text.split('\n')) if (line.trim()) print(line.trim(), 'tx');
      }
      break;
    case 'realtime':
      if (Number.isInteger(msg.byte) && msg.byte >= 0 && msg.byte < 256) sim?.realtime(msg.byte);
      break;
    case 'speed':
      if (typeof msg.value === 'number' && msg.value >= 0) setSpeed(msg.value);
      break;
    case 'program':
      if (msg.text == null) clearProgram();
      else if (typeof msg.text === 'string') loadProgram(msg.name ?? 'Program', msg.text);
      break;
    case 'reboot':
      reboot({ factory: !!msg.factory }).catch(() => {});
      break;
    case 'stock': {
      const box = validBox(msg.box);
      if (box !== undefined) setStock(box);
      break;
    }
    case 'tool': {
      const tool = msg.tool;
      if (tool !== null && !normalizeTool(tool)) break;
      apiTool = tool && normalizeTool(tool);
      applyTools();
      break;
    }
    case 'tools': {
      if (msg.tools !== null && (typeof msg.tools !== 'object' || Array.isArray(msg.tools))) break;
      clientTools = cleanTools(msg.tools ?? {});
      renderTools();
      applyTools();
      break;
    }
    case 'simulate':
      if (typeof msg.text === 'string') {
        const error = simulate(msg.text, { name: msg.name, resolution: positive(msg.resolution) ? msg.resolution : undefined });
        if (error) bridge.send({ type: 'simulation', state: 'failed', message: error, progress: null, findings: [], stats: null });
      }
      break;
    case 'cancelSimulation':
      simulation?.cancel();
      break;
    case 'exportStock':
      exportStock(msg.source === 'simulation' ? 'simulation' : 'live').then((result) => bridge.send({ type: 'stockExport', ...result }));
      break;
    case 'probe':
      if (msg.plate === null || (typeof msg.plate === 'number' && msg.plate >= 0)) {
        fixture.plate = msg.plate ?? 0;
        applyFixture();
      }
      break;
    case 'view':
      if (typeof msg.program === 'boolean') viewer.setProgramVisible(msg.program);
      if (msg.stock === 'live' || msg.stock === 'simulation') setStockView(msg.stock);
      break;
  }
};

// The optional messages this app understands, for clients to check (connected.features).
const FEATURES = ['stock', 'tool', 'probe', 'view', 'tools', 'cutting', 'simulate', 'exportStock'];

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// A stock box from a client: { min: [x, y, z], max: [x, y, z] }, null to clear,
// or undefined if it isn't one.
function validBox(box) {
  if (box === null) return null;
  const ok = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!box || !ok(box.min) || !ok(box.max) || box.min.some((v, i) => v > box.max[i])) return undefined;
  return { min: [...box.min], max: [...box.max] };
}

function applyFixture() {
  if (sim) sim.fixture = { ...fixture };
}

// --- Stock and tools ---------------------------------------------------------

// The machine cuts whatever stock is on it: the live stock follows the
// firmware's position samples. Tools come from the tool table (T numbers) or
// a client's tool message.
const liveStock = new StockWorker();
let tools = cleanTools(readJson(TOOLS_KEY) ?? { 1: { diameter: DEFAULT_TOOL.diameter, length: DEFAULT_TOOL.length, fluteLength: 12, shape: 'flat' } });
let clientTools = {};  // a connected client's tool table (tools message), in place of the local one
let apiTool = null;     // the tool a client put in the collet (tool message), if any
let followedTool = 0;   // the tool number the machine view shows
let stockView = 'live';
let simulation = null;

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

function cleanTools(table) {
  const out = {};
  for (const [n, spec] of Object.entries(table ?? {})) {
    const tool = normalizeTool(spec);
    if (tool && Number.isInteger(+n) && +n >= 0) out[+n] = tool;
  }
  return out;
}

// While a client is connected, its own tools; otherwise the local table.
function activeTools() {
  return bridge.connected ? clientTools : tools;
}

// The tool in the collet unless the program selects another: the client's,
// or locally the lowest numbered in the table.
function defaultTool() {
  if (bridge.connected) return apiTool ?? normalizeTool(DEFAULT_TOOL);
  const numbers = Object.keys(tools).map(Number).sort((a, b) => a - b);
  return numbers.length ? tools[numbers[0]] : normalizeTool(DEFAULT_TOOL);
}

function toolFor(number) {
  return activeTools()[number] ?? defaultTool();
}

// The machine was zeroed with the default tool: its stick-out is how far the
// tip is below the collet face, for the firmware's probe and for cutting.
function applyTools() {
  const tool = defaultTool();
  fixture.toolLength = tool.length;
  applyFixture();
  followedTool = -1;
  followTool(0);
  liveStock.setTools(activeTools(), tool, tool.length);
}

// Draws the tool the program selected. Tools are assumed touched off after a
// change, so the tip stays where the default tool's would be.
function followTool(number) {
  if (number === followedTool || !Number.isFinite(number)) return;
  followedTool = number;
  viewer.setTool({ ...toolFor(number), length: fixture.toolLength });
}

function setStock(box, { persist = !bridge.connected } = {}) {
  fixture.stock = box;
  viewer.setStock(box);
  applyFixture();
  resetLiveStock();
  if (persist) writeJson(STOCK_KEY, box);
  $('stock-meta').textContent = box
    ? `${box.max.map((v, i) => (v - box.min[i]).toFixed(1)).join(' × ')} mm, top at Z ${box.max[2].toFixed(2)} on the machine`
    : 'No stock on the machine';
  updateSimulationUi();
}

function resetLiveStock() {
  if (!fixture.stock) {
    liveStock.clear();
    if (stockView === 'live') {
      viewer.setStockModel(null);
      viewer.setFindings([]);
    }
    return;
  }
  const tool = defaultTool();
  liveStock.init(fixture.stock, { tools: activeTools(), tool, tipLength: tool.length });
}

let liveReported = 0;   // live findings already printed
liveStock.onModel = (model) => {
  if (!liveStock.findings.length) liveReported = 0;
  if (stockView === 'live') viewer.setStockModel(model);
};
liveStock.onTiles = (tiles) => {
  if (stockView === 'live') viewer.updateStockTiles(tiles);
};

liveStock.onFindings = (findings) => {
  if (stockView === 'live') viewer.setFindings(findings);
  for (const f of findings.slice(liveReported)) print(`${f.severity === 'error' ? 'Collision' : 'Warning'}: ${f.message}`, f.severity === 'error' ? 'error' : 'alarm');
  liveReported = findings.length;
  bridge.send({ type: 'findings', source: 'live', findings });
};

// Work zero on the stock's top, `offset` [x, y] in from its front left corner.
function placeStock() {
  const size = ['stock-x', 'stock-y', 'stock-z'].map((id) => parseFloat($(id).value));
  const offset = ['stock-ox', 'stock-oy'].map((id) => parseFloat($(id).value) || 0);
  if (!size.every((v) => v > 0)) return print('Stock: give it a size in X, Y and Z', 'error');
  const zero = viewer.workOrigin.position;
  const min = [zero.x - offset[0], zero.y - offset[1], zero.z - size[2]];
  setStock({ min, max: [min[0] + size[0], min[1] + size[1], zero.z] });
}

$('stock-place').onclick = placeStock;
$('stock-reset').onclick = resetLiveStock;
$('stock-remove').onclick = () => setStock(null);

// Tool table rows: T, shape, diameter, angle, flute length, stick-out.
function renderTools() {
  const table = $('tools');
  for (const row of table.querySelectorAll('.tool-row')) row.remove();
  for (const [n, tool] of Object.entries(activeTools()).sort((a, b) => a[0] - b[0])) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.dataset.n = n;
    const number = (key, value, step = 'any', title = '') =>
      `<input data-key="${key}" type="number" step="${step}" min="0" value="${+value.toFixed(3)}" title="${title}" />`;
    row.innerHTML = [
      number('n', +n, 1, 'Tool number'),
      `<select data-key="shape" title="Shape">${SHAPES.map((s) => `<option${s === tool.shape ? ' selected' : ''}>${s}</option>`).join('')}</select>`,
      number('diameter', tool.diameter, 'any', 'Diameter'),
      number('angle', tool.angle, 'any', 'V bit angle'),
      number('fluteLength', tool.fluteLength, 'any', 'Flute length'),
      number('length', tool.length, 'any', 'Stick-out below the collet'),
      `<button data-remove title="Remove">×</button>`,
    ].join('');
    for (const el of row.querySelectorAll('input, select, button')) el.disabled = bridge.connected; // a client's tools
    row.querySelector('[data-key="angle"]').disabled = tool.shape !== 'v' || bridge.connected;
    table.append(row);
  }
}

function saveTools() {
  if (!bridge.connected) writeJson(TOOLS_KEY, tools);
  applyTools();
}

$('tools').addEventListener('change', (e) => {
  const row = e.target.closest('.tool-row');
  if (!row) return;
  const n = +row.dataset.n;
  const key = e.target.dataset.key;
  const value = key === 'shape' ? e.target.value : parseFloat(e.target.value);
  if (key === 'n') {
    if (Number.isInteger(value) && value >= 0 && !tools[value]) {
      tools[value] = tools[n];
      delete tools[n];
    }
  } else {
    const tool = normalizeTool({ ...tools[n], [key]: value, ...(key === 'length' && tools[n].fluteLength >= tools[n].length ? { fluteLength: value } : {}) });
    if (tool) tools[n] = tool;
  }
  renderTools();
  saveTools();
});

$('tools').addEventListener('click', (e) => {
  const row = e.target.closest('.tool-row');
  if (!row || !e.target.matches('[data-remove]')) return;
  delete tools[row.dataset.n];
  renderTools();
  saveTools();
});

$('tool-add').onclick = () => {
  let n = 1;
  while (tools[n]) n++;
  tools[n] = normalizeTool({ diameter: 6, length: 30, fluteLength: 20 });
  renderTools();
  saveTools();
};

// --- Simulation --------------------------------------------------------------

function setStockView(view) {
  stockView = view;
  for (const b of $('stock-view').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.view === view));
  viewer.setStockModel(null);
  viewer.setFindings([]);
  const source = view === 'simulation' ? simulation?.stock : liveStock;
  if (source?.model) {
    source.resend();
    viewer.setFindings(source.findings);
  }
}

for (const button of $('stock-view').querySelectorAll('button')) {
  button.addEventListener('click', () => setStockView(button.dataset.view));
}

// Runs `text` on a separate controller against the stock on the machine.
// Returns an error message if it can't.
function simulate(text, { name, resolution } = {}) {
  if (!fixture.stock) return 'no stock on the machine';
  simulation?.dispose();
  const tool = defaultTool();
  const run = (simulation = new Simulation({
    text,
    box: fixture.stock,
    tools: activeTools(),
    tool,
    tipLength: tool.length,
    resolution,
    nvs: latestNvs,
    fixture: { ...fixture },
    firmware,
  }));
  run.name = name ?? 'Program';
  run.onModel = (model) => {
    if (stockView === 'simulation' && simulation === run) viewer.setStockModel(model);
  };
  run.onTiles = (tiles) => {
    if (stockView === 'simulation' && simulation === run) viewer.updateStockTiles(tiles);
  };
  run.onChange = () => {
    if (simulation === run) scheduleSimulationUi();
  };
  setStockView('simulation');
  print(`Simulating ${run.name}`, 'note');
  run.run().then(() => {
    if (simulation !== run) return;
    print(`Simulation: ${run.message}${run.findings.length ? `, ${describeCounts(run.stats)}` : ', no collisions'}`, 'note');
    updateSimulationUi();
  });
  updateSimulationUi();
  return null;
}

$('simulate').onclick = () => {
  if (programText) simulate(programText, { name: $('program-name').textContent });
};
$('sim-cancel').onclick = () => simulation?.cancel();

function describeCounts(stats) {
  const parts = [];
  if (stats?.errors) parts.push(`${stats.errors} error${stats.errors > 1 ? 's' : ''}`);
  if (stats?.warnings) parts.push(`${stats.warnings} warning${stats.warnings > 1 ? 's' : ''}`);
  return parts.join(', ') || 'no findings';
}

// A timer, not requestAnimationFrame: an embedded app may be in a hidden
// frame, and its client still wants to hear how the simulation is going.
let simUiQueued = false;
function scheduleSimulationUi() {
  if (simUiQueued) return;
  simUiQueued = true;
  setTimeout(() => {
    simUiQueued = false;
    updateSimulationUi();
  }, 50);
}

let lastSimSent = 0;
function updateSimulationUi() {
  const run = simulation;
  const busy = run && !run.finished;
  $('simulate').disabled = bridge.connected || !!busy || !programText || !fixture.stock;
  $('sim-cancel').disabled = bridge.connected || !busy;
  $('stock-view').querySelector('[data-view="simulation"]').disabled = bridge.connected || !run;
  if (!run) {
    $('sim-status').textContent = !fixture.stock ? 'Put a stock on the machine and load a program.' : !programText ? 'Load a program to simulate.' : 'Ready.';
    $('findings').replaceChildren();
    return;
  }

  const { acked, total, time } = run.progress;
  $('sim-progress').style.width = `${(100 * acked) / Math.max(1, total)}%`;
  const removed = run.stats ? ` · ${(run.stats.removed / 1000).toFixed(1)} cm³ removed` : '';
  $('sim-status').textContent = `${run.message}${busy ? ` · line ${acked} of ${total} · ${time.toFixed(0)} s machine time` : ''}${removed}`;

  $('findings').replaceChildren(...run.findings.map((f) => {
    const li = document.createElement('li');
    li.className = f.severity;
    const button = document.createElement('button');
    button.title = f.at ? 'Show where' : '';
    button.innerHTML = '<span class="dot"></span><span class="where"></span><span class="what"></span>';
    button.querySelector('.where').textContent = f.line ? `Line ${f.line}` : '—';
    button.querySelector('.what').textContent = f.message + (f.count > 1 ? ` (${f.count}×)` : '');
    button.onclick = () => f.at && viewer.focus(f.at);
    li.append(button);
    return li;
  }));
  if (stockView === 'simulation') viewer.setFindings(run.findings);

  const now = performance.now();
  if (bridge.connected && (run.finished || now - lastSimSent > 100)) {
    lastSimSent = now;
    bridge.send({ type: 'simulation', state: run.state, message: run.message, progress: { ...run.progress }, findings: run.findings, stats: run.stats });
  }
}

// The heightfield of the live or the simulated stock.
async function exportStock(source) {
  const stock = source === 'simulation' ? simulation?.stock : liveStock;
  const result = stock && (await stock.export());
  return { source, model: result?.model ?? null, heights: result?.heights ?? null, findings: result?.findings ?? [], stats: result?.stats ?? null };
}

// --- Status ------------------------------------------------------------------

const dro = $('dro');
const droCells = AXES.map((axis) => {
  const row = document.createElement('div');
  row.className = 'dro-row';
  row.innerHTML = `<span class="axis">${axis}</span><span class="work">0.000</span><span class="mach">0.000</span>`;
  dro.append(row);
  return { work: row.children[1], mach: row.children[2] };
});

sender.onStatus = (s) => {
  const state = s.state.split(':')[0];
  $('state').textContent = s.state;
  $('state').dataset.state = state;
  droCells.forEach((c, i) => {
    c.work.textContent = (s.wpos[i] ?? 0).toFixed(3);
    c.mach.textContent = (s.mpos[i] ?? 0).toFixed(3);
  });
  $('feed').textContent = Math.round(s.feed);
  $('rpm').textContent = Math.round(s.rpm);
  $('pins').textContent = s.pins || '–';
  viewer.setWorkOffset(s.wco);
  updateProgramButtons();
};

function tick() {
  const now = performance.now();
  if (sim) {
    // Extrapolate between yields so the clock does not stutter.
    const since = now - sim.simTimeWall;
    const t = sim.simTime + (since < 100 && sim.speed ? (since / 1000) * sim.speed : 0);
    $('simtime').textContent = `${t.toFixed(3)} s`;

    if (now - rateWindow.wall > 1000) {
      const rate = (sim.simTime - rateWindow.t) / ((now - rateWindow.wall) / 1000);
      $('rate').textContent = rate >= 0 ? `${rate.toFixed(rate < 10 ? 2 : 0)}× real time` : '–';
      rateWindow = { t: sim.simTime, wall: now };
    }
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- Controls ----------------------------------------------------------------

for (const button of $('speed').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    setSpeed(parseFloat(button.dataset.speed));
    bridge.send({ type: 'speed', value: speed });
  });
}

const command = (text) => sender.send(text).catch(() => {});

$('home').onclick = () => command('$H');
$('unlock').onclick = () => command('$X');
$('zero').onclick = () => command('G10 L20 P1 X0 Y0 Z0');
$('reset').onclick = () => sender.stop();
$('hold').onclick = () => sender.realtime('hold');
$('resume').onclick = () => sender.realtime('resume');
$('fit').onclick = () => viewer.fit();
$('clear-trail').onclick = () => viewer.clearTrail();

for (const button of document.querySelectorAll('[data-jog]')) {
  button.addEventListener('click', () => {
    const [axis, dir] = button.dataset.jog;
    sender.jog(axis, (dir === '-' ? -1 : 1) * parseFloat($('jog-step').value), $('jog-feed').value);
  });
}

$('command').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('command-input');
  const text = input.value.trim();
  if (!text) return;
  if (text === '?' || text === '!' || text === '~') sender.realtime(text);
  else command(text);
  input.value = '';
});

// --- Program -----------------------------------------------------------------

let programText = null;

function loadProgram(name, text) {
  programText = text;
  sender.loadProgram(text);
  const parsed = parseGcode(text);
  viewer.setProgram(parsed);
  $('program-name').textContent = name;
  const b = parsed.bounds;
  $('program-meta').textContent = b
    ? `${sender.program.lines.length} lines · ${AXES.map((a, i) => `${a} ${b.min[i].toFixed(1)}…${b.max[i].toFixed(1)}`).join('  ')}`
    : `${sender.program.lines.length} lines`;
  updateProgramButtons();
  updateSimulationUi();
}

function clearProgram() {
  programText = null;
  sender.program = null;
  viewer.setProgram(null);
  $('program-name').textContent = 'No program loaded';
  $('program-meta').textContent = '';
  $('progress-bar').style.width = '0';
  updateProgramButtons();
  updateSimulationUi();
}

function updateProgramButtons() {
  const p = sender.program;
  const state = sender.status.state;
  $('run').disabled = bridge.connected || !p || p.running || !(state === 'Idle' || state.startsWith('Check'));
  $('run').textContent = p?.done ? 'Run again' : 'Start';
}

sender.onProgram = (p) => {
  $('progress-bar').style.width = `${(100 * p.acked) / Math.max(1, p.lines.length)}%`;
  if (p.done) print(`Program finished${p.errors ? ` with ${p.errors} error(s)` : ''}`, 'note');
  updateProgramButtons();
};

$('run').onclick = () => {
  viewer.clearTrail();
  sender.start();
};
$('demo').onclick = () => {
  loadProgram('Demo job', demoProgram());
  if (!fixture.stock) {
    // The demo's stock, at the work origin it was written for.
    const { size, offset } = demoStock;
    ['stock-x', 'stock-y', 'stock-z'].forEach((id, i) => ($(id).value = size[i]));
    ['stock-ox', 'stock-oy'].forEach((id, i) => ($(id).value = offset[i]));
    placeStock();
  }
};
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadProgram(file.name, await file.text());
  e.target.value = '';
});

// --- Boot --------------------------------------------------------------------

setStock(validBox(readJson(STOCK_KEY)) ?? null, { persist: false });
renderTools();
applyTools();
updateSimulationUi();

bridge.listen();
await boot();
if (!bridge.connected) sender.startPolling(5);
