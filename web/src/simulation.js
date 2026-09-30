// SPDX-License-Identifier: LGPL-3.0-or-later
// Background simulation: runs a G-code program on a second, independent
// grblHAL - with a copy of the live controller's settings and work offsets,
// as fast as it will go - and cuts it out of the stock, checking for
// collisions. The live machine isn't touched.
//
// It does what an operator would: homes (or unlocks) the machine, streams the
// program with each line numbered by its line in the source text (so every
// finding points at one), resumes after M0/M1 pauses and tool changes, and
// stops on an alarm. After a tool change the new tool is assumed touched off.

import { GrblHALWorker } from './sim/index.js';
import { SAMPLE } from './sim/samples.js';
import { Sender, programLines } from './sender.js';
import { StockWorker } from './stock/client.js';

const STALL_MS = 20000;         // wall time without progress before giving up
const BOOT_TIMEOUT_MS = 30000;

// grblHAL alarm codes (grbl/alarms.h), for findings.
const ALARMS = {
  1: 'hard limit', 2: 'soft limit: the move is outside the machine travel', 3: 'reset while in motion',
  4: 'probe fail', 5: 'probe fail', 6: 'homing fail (reset)', 7: 'homing fail (door)',
  8: 'homing fail (pull-off)', 9: 'homing fail (approach)', 10: 'e-stop', 11: 'homing required',
  12: 'limit switch engaged', 13: 'probe protection', 14: 'spindle at speed timeout', 15: 'homing fail (auto-squaring)',
  17: 'motor fault',
};

export class Simulation {
  state = 'idle';               // starting, homing, running, then done, stopped (by an alarm), failed or cancelled
  message = '';
  progress = { acked: 0, total: 0, time: 0 };
  findings = [];
  stats = null;
  stock = null;                 // the StockWorker with the result

  onChange = null;              // () state, progress or findings changed
  onModel = null;               // (model) the stock grid, for a viewer
  onTiles = null;               // (tiles)

  #options;
  #fw = null;
  #sender = null;
  #lastLine = 0;
  #samples = 0;                 // position samples so far: motion and state changes
  #statusSeq = 0;
  #finishing = null;
  #lastClockReport = 0;

  // text: the program. box: the stock, physical { min, max }. tools, tool,
  // tipLength, resolution: see Cutter. nvs: the controller's settings (NVS
  // image) to start from. fixture: the tool length, stock and touch plate as
  // the firmware sees them (GrblHAL.fixture).
  constructor(options) {
    this.#options = options;
  }

  get finished() {
    return ['done', 'stopped', 'failed', 'cancelled'].includes(this.state);
  }

  async run() {
    const o = this.#options;
    const lines = programLines(o.text).map(numbered).filter((l) => l.send);
    this.progress.total = lines.length;

    const stock = (this.stock = new StockWorker());
    stock.onModel = (m) => this.onModel?.(m);
    stock.onTiles = (t) => this.onTiles?.(t);
    stock.onFindings = (f) => {
      this.findings = f;
      this.onChange?.();
    };
    stock.onStats = (s) => (this.stats = s);
    stock.init(o.box, { resolution: o.resolution, tools: o.tools, tool: o.tool, tipLength: o.tipLength });

    try {
      this.#set('starting', 'Booting the controller');
      const fw = (this.#fw = new GrblHALWorker({
        speed: 0,
        samples: true,
        samplePeriod: 0,              // only where the path turns: the stock needs nothing more
        firmware: o.firmware ?? 'auto',
        fixture: o.fixture,
        nvsLoad: (dest) => {
          if (!o.nvs) return false;
          dest.set(o.nvs.subarray(0, dest.length));
          return true;
        },
        onSamples: (data, count, stride) => {
          this.#lastLine = data[(count - 1) * stride + SAMPLE.LINE] || this.#lastLine;
          this.#samples += count;
          stock.addSamples(data, count, stride);
        },
        onClock: (t) => {
          this.progress.time = t;
          const now = performance.now();
          if (now - this.#lastClockReport > 250) {
            this.#lastClockReport = now;
            this.onChange?.();
          }
        },
        onCrash: (err) => this.#fail(`the firmware crashed: ${err?.message ?? err}`),
      }));

      const sender = (this.#sender = new Sender());
      sender.attach(fw);
      const booted = new Promise((resolve) => (sender.onReset = resolve));
      sender.onStatus = () => this.#statusSeq++;
      sender.onLine = (text, kind) => {
        if (kind === 'alarm') this.#alarm(text);
      };
      sender.onError = (text, error) => {
        stock.report('error', { line: lineOf(text), message: `${error}: ${text}` });
      };
      sender.onProgram = (p) => {
        this.progress.acked = p.acked;
        this.onChange?.();
      };

      await fw.start();
      await this.#until(() => booted, BOOT_TIMEOUT_MS, 'the controller did not boot');
      sender.startPolling(20);
      await this.#waitFor(() => sender.status.state !== 'Unknown', 'no status from the controller');
      await sender.send('$$');

      if (sender.status.state.startsWith('Alarm')) {
        const homing = +(sender.settings.get(22) ?? 0) & 1;
        this.#set('homing', homing ? 'Homing' : 'Unlocking');
        const error = await sender.send(homing ? '$H' : '$X');
        if (error) throw new Error(`${homing ? 'homing' : 'unlocking'} failed: ${error}`);
      }
      await this.#waitFor(() => sender.status.state === 'Idle', 'the controller is not idle');

      this.#set('running', 'Running the program');
      sender.loadLines(lines.map((l) => l.send));
      sender.start();

      // Stalled: no line acknowledged and nothing moved or changed state for a
      // while (the simulated clock itself always runs).
      let resumedAt = 0, doneSeq = -1, lastProgress = { acked: -1, samples: -1, wall: performance.now() };
      await this.#waitFor(() => {
        const p = sender.program;
        const state = sender.status.state;
        const now = performance.now();
        // An operator: resume after a program pause (M0/M1) or a tool change.
        if ((state === 'Tool' || state === 'Hold:0') && now - resumedAt > 250) {
          resumedAt = now;
          sender.realtime('resume');
        }
        if (p.acked !== lastProgress.acked || this.#samples !== lastProgress.samples) {
          lastProgress = { acked: p.acked, samples: this.#samples, wall: now };
        } else if (now - lastProgress.wall > STALL_MS) {
          throw new Error(`the program stopped making progress at line ${this.#lastLine} (${state})`);
        }
        // Done once the controller reports idle after the last line was acknowledged.
        if (p.done && doneSeq < 0) doneSeq = this.#statusSeq;
        return p.done && state === 'Idle' && this.#statusSeq > doneSeq;
      }, null, Infinity);

      await this.#finish('done', `Finished in ${formatTime(this.progress.time)} of machine time`);
    } catch (err) {
      await this.#finish('failed', err?.message ?? String(err));
    }
  }

  // Stops the run; the stock stays as far as it got.
  cancel() {
    return this.#finish('cancelled', 'Cancelled');
  }

  // Frees the stock worker too.
  dispose() {
    this.#finish('cancelled', 'Cancelled');
    this.stock?.terminate();
  }

  #alarm(text) {
    // Booting into an alarm (homing required) is what homing is for.
    if (this.state !== 'homing' && this.state !== 'running') return;
    const code = +text.split(':')[1];
    const line = this.#lastLine;
    this.stock.report('alarm', { line, message: `${text}${ALARMS[code] ? `: ${ALARMS[code]}` : ''}` });
    this.#finish('stopped', `Stopped by ${text}${line ? ` at line ${line}` : ''}`);
  }

  #fail(message) {
    this.#finish('failed', message);
  }

  // Ends the run, once: the first reason to stop wins.
  #finish(state, message) {
    this.#finishing ??= (async () => {
      this.#set(state, message);
      this.#sender?.stopPolling();
      await this.#fw?.stop();
      if (!this.stock) return;
      await this.stock.flush();
      this.findings = this.stock.findings;
      this.stats = this.stock.stats;
      this.onChange?.();
    })();
    return this.#finishing;
  }

  #set(state, message) {
    this.state = state;
    this.message = message;
    this.onChange?.();
  }

  // Resolves when pred() is true; throws its error message after `timeout`,
  // or as soon as the run is ending for another reason.
  #waitFor(pred, error = 'timed out', timeout = BOOT_TIMEOUT_MS) {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        try {
          if (this.#finishing) return reject(new Error('stopped'));
          if (pred()) return resolve();
          if (performance.now() - start > timeout) return reject(new Error(error));
          setTimeout(check, 20);
        } catch (err) {
          reject(err);
        }
      };
      check();
    });
  }

  #until(promise, timeout, error) {
    let done = false;
    promise().then(() => (done = true));
    return this.#waitFor(() => done, error, timeout);
  }
}

// A program line to send, numbered with its line in the source (N words in
// the program are replaced). $ commands can't take a line number.
function numbered({ text, source }) {
  if (text.startsWith('$')) return { source, send: text };
  const rest = text.replace(/^N\s*\d+\s*/i, '');
  return { source, send: rest ? `N${source} ${rest}` : null };
}

function lineOf(text) {
  const m = /^N(\d+)/.exec(text);
  return m ? +m[1] : 0;
}

function formatTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
}
