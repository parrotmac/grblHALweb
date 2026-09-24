import './style.css';
import { GrblHAL } from './grblhal.js';
import { loadFirmware } from './firmware.js';
import { Sender } from './sender.js';
import { Viewer } from './viewer.js';
import { parseGcode } from './gcode.js';
import { demoProgram, machinePreset, PRESET_VERSION } from './demo.js';

const $ = (id) => document.getElementById(id);
const AXES = ['X', 'Y', 'Z'];
const NVS_KEY = 'grblhal-web:nvs';
const PRESET_KEY = 'grblhal-web:preset';

const viewer = new Viewer($('viewport'));
if (import.meta.env.DEV) Object.assign(window, { viewer }); // for poking at from devtools
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => viewer.applyTheme());

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

let freshNvs = false;
let rateWindow = { t: 0, wall: performance.now() };

const sim = new GrblHAL({
  speed: 1,
  onSamples(data, count, stride) {
    viewer.addSamples(data, count, stride);
  },
  nvsLoad(dest) {
    try {
      const saved = localStorage.getItem(NVS_KEY);
      if (!saved) return (freshNvs = true, false);
      dest.set(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)).subarray(0, dest.length));
      return true;
    } catch {
      freshNvs = true;
      return false;
    }
  },
  nvsSave(data) {
    try {
      localStorage.setItem(NVS_KEY, btoa(String.fromCharCode(...data)));
    } catch {
      /* private mode: settings last for this session only */
    }
  },
  onCrash(err) {
    print(`Firmware crashed: ${err?.message ?? err}`, 'error');
    console.error(err);
  },
});

const sender = new Sender(sim);

sender.onLine = (text, kind) => print(text, text === 'ok' ? 'ok' : kind);

function presetApplied() {
  try {
    return localStorage.getItem(PRESET_KEY) === String(PRESET_VERSION);
  } catch {
    return false;
  }
}

sender.onReset = async () => {
  if (freshNvs || !presetApplied()) {
    print(`${freshNvs ? 'Fresh controller' : 'Updated demo machine'}: applying the demo machine settings`, 'note');
    freshNvs = false;
    try {
      localStorage.setItem(PRESET_KEY, String(PRESET_VERSION));
    } catch {
      /* private mode */
    }
    await Promise.all(machinePreset.map((cmd) => sender.send(cmd)));
    sender.stop(); // reboot so homing and limit settings take effect
    return;
  }
  sender.send('$$').catch(() => {});
};

sender.onSettings = (settings) => {
  const travel = [130, 131, 132].map((n) => parseFloat(settings.get(n)) || 0);
  if (travel.join() !== viewer.envelope.join() && travel.every((t) => t > 0)) {
    viewer.setEnvelope(travel);
    viewer.fit();
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
  updateProgramButtons();
};

// Where grbl's machine origin sits on the physical machine, per axis, once
// homed: limits_set_machine_positions() in core puts it at physical =
// MPos + travel, except with "force origin" ($22 bit 3) and a negative homing
// direction ($23), where the switch position becomes MPos 0.
function homedFrameOffset() {
  const num = (n) => parseFloat(sender.settings.get(n)) || 0;
  const forceOrigin = num(22) & 8;
  const dirMask = num(23);
  return AXES.map((_, i) => (forceOrigin && dirMask & (1 << i) ? 0 : Math.abs(num(130 + i))));
}

// Work origin in physical coordinates = WCO + (physical - grbl MPos). Before
// the machine is homed that frame is wherever it powered on, so while homing
// is still required (alarm, not homed) show the program where it will run
// once homed; during homing the frame is in flux, so leave it where it was.
function updateWorkOrigin() {
  if (!viewer.mposOffset) return;
  const state = sender.status.state.split(':')[0];
  if (state === 'Home') return;

  const allHomed = viewer.homed === (1 << viewer.nAxes) - 1;
  const provisional = !allHomed && (state === 'Alarm' || state === 'Unknown') && sender.settings.has(130);
  const offset = provisional ? homedFrameOffset() : viewer.mposOffset;

  viewer.setWorkOrigin(sender.status.wco.map((w, i) => w + offset[i]));
  viewer.setPreviewProvisional(provisional);
}

function tick() {
  const now = performance.now();
  // Extrapolate between yields so the clock does not stutter.
  const since = now - sim.simTimeWall;
  const t = sim.simTime + (since < 100 && sim.speed ? (since / 1000) * sim.speed : 0);
  $('simtime').textContent = `${t.toFixed(3)} s`;

  if (now - rateWindow.wall > 1000) {
    const rate = (sim.simTime - rateWindow.t) / ((now - rateWindow.wall) / 1000);
    $('rate').textContent = `${rate.toFixed(rate < 10 ? 2 : 0)}× real time`;
    rateWindow = { t: sim.simTime, wall: now };
  }

  updateWorkOrigin();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- Controls ----------------------------------------------------------------

for (const button of $('speed').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    sim.speed = parseFloat(button.dataset.speed);
    for (const b of $('speed').querySelectorAll('button')) b.setAttribute('aria-checked', String(b === button));
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

function updateProgramButtons() {
  const p = sender.program;
  const state = sender.status.state;
  $('run').disabled = !p || p.running || !(state === 'Idle' || state.startsWith('Check'));
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

const { factory, variant } = await loadFirmware();
$('variant').textContent = variant;
print(`Loading grblHAL (${variant} build)…`, 'note');
await sim.start(factory);
sender.startPolling(5);
