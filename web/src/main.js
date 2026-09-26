// SPDX-License-Identifier: LGPL-3.0-or-later

import './style.css';
import { GrblHALWorker, jspiSupported } from './sim/index.js';
import { Sender } from './sender.js';
import { MachineViewer, parseGcode } from './viewer/index.js';
import { Bridge, PROTOCOL } from './bridge.js';
import { demoProgram, machinePreset, PRESET_VERSION } from './demo.js';

const $ = (id) => document.getElementById(id);
const AXES = ['X', 'Y', 'Z'];
const NVS_KEY = 'grblhal-web:nvs';
const PRESET_KEY = 'grblhal-web:preset';
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
let freshNvs = false;
let rateWindow = { t: 0, wall: performance.now() };

function loadNvs(dest) {
  try {
    const saved = localStorage.getItem(NVS_KEY);
    if (!saved) return (freshNvs = true, false);
    dest.set(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)).subarray(0, dest.length));
    return true;
  } catch {
    freshNvs = true;
    return false;
  }
}

function saveNvs(data) {
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
      viewer.addSamples(data, count, stride);
      if (bridge.samples) bridge.send({ type: 'samples', data, count, stride });
    },
    onBytes: (bytes) => bridge.send({ type: 'serial', bytes }),
    onClock: (time) => bridge.send({ type: 'clock', time }),
    nvsLoad: loadNvs,
    nvsSave: saveNvs,
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
  $('remote').hidden = !remote;
  $('remote').textContent = remote ? `Driven by ${origin}` : '';
  $('remote').title = remote ? `${origin} is connected over postMessage and drives the serial link` : '';
  for (const el of $('panel').querySelectorAll('button, input, select')) el.disabled = remote;
  updateProgramButtons();
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
  }
};

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

function loadProgram(name, text) {
  sender.loadProgram(text);
  const parsed = parseGcode(text);
  viewer.setProgram(parsed);
  $('program-name').textContent = name;
  const b = parsed.bounds;
  $('program-meta').textContent = b
    ? `${sender.program.lines.length} lines · ${AXES.map((a, i) => `${a} ${b.min[i].toFixed(1)}…${b.max[i].toFixed(1)}`).join('  ')}`
    : `${sender.program.lines.length} lines`;
  updateProgramButtons();
}

function clearProgram() {
  sender.program = null;
  viewer.setProgram(null);
  $('program-name').textContent = 'No program loaded';
  $('program-meta').textContent = '';
  $('progress-bar').style.width = '0';
  updateProgramButtons();
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
$('demo').onclick = () => loadProgram('Demo job', demoProgram());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadProgram(file.name, await file.text());
  e.target.value = '';
});

// --- Boot --------------------------------------------------------------------

bridge.listen();
await boot();
if (!bridge.connected) sender.startPolling(5);
