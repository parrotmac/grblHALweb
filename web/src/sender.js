// A G-code sender for the simulated controller: character-counting streaming
// (keeps grblHAL's RX buffer full instead of waiting for each "ok"), status
// polling and parsing of the replies a UI needs.

const RT = {
  status: '?',
  hold: '!',
  resume: '~',
  reset: '\x18',
  jogCancel: '\x85',
};

export class Sender {
  #queue = [];          // lines waiting to be sent: { text, program }
  #inFlight = [];       // lines sent but not yet acknowledged
  #inFlightBytes = 0;
  #rxSize = 1023;       // usable RX buffer, refined from [OPT:]
  #pollTimer = null;

  status = { state: 'Unknown', mpos: [0, 0, 0], wco: [0, 0, 0], feed: 0, rpm: 0, ov: [100, 100, 100], pins: '' };
  settings = new Map();
  program = null;       // { lines, sent, acked, errors, running }

  // Callbacks
  onLine = null;        // (text, kind) kind: 'rx' | 'tx' | 'error' | 'alarm' | 'msg'
  onStatus = null;      // (status)
  onProgram = null;     // (program)
  onSettings = null;    // (settings)
  onReset = null;       // () controller (re)booted

  constructor(sim) {
    this.sim = sim;
    sim.onLine = (line) => this.#receive(line);
  }

  startPolling(hz = 5) {
    clearInterval(this.#pollTimer);
    this.#pollTimer = setInterval(() => this.sim.realtime(RT.status.charCodeAt(0)), 1000 / hz);
  }

  // Interactive command, sent after anything already queued. Resolves with
  // null on "ok" or the error string; rejects if a reset discards it.
  send(text) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ text: text.trim(), program: false, resolve, reject });
      this.#pump();
    });
  }

  realtime(cmd) {
    const byte = typeof cmd === 'number' ? cmd : (RT[cmd] ?? cmd).charCodeAt(0);
    this.sim.realtime(byte);
  }

  jog(axis, distance, feed) {
    return this.send(`$J=G91 G21 ${axis}${distance} F${feed}`).catch(() => null);
  }

  loadProgram(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/\(.*?\)|;.*$/g, '').trim())
      .filter((l) => l.length && l !== '%');
    this.program = { lines, sent: 0, acked: 0, errors: 0, running: false, done: false };
    this.onProgram?.(this.program);
  }

  start() {
    const p = this.program;
    if (!p || p.running) return;
    if (p.done) Object.assign(p, { sent: 0, acked: 0, errors: 0, done: false });
    p.running = true;
    for (let i = p.sent; i < p.lines.length; i++) this.#queue.push({ text: p.lines[i], program: true });
    p.sent = p.lines.length;
    this.onProgram?.(p);
    this.#pump();
  }

  // Soft reset: the controller flushes its buffers, so do we.
  stop() {
    this.realtime('reset');
  }

  #flush() {
    for (const line of [...this.#inFlight, ...this.#queue]) line.reject?.(new Error('reset'));
    this.#queue = [];
    this.#inFlight = [];
    this.#inFlightBytes = 0;
    if (this.program?.running) {
      this.program.running = false;
      this.program.sent = this.program.acked;
      this.onProgram?.(this.program);
    }
  }

  #pump() {
    while (this.#queue.length) {
      const next = this.#queue[0];
      const len = next.text.length + 1;
      if (this.#inFlight.length && this.#inFlightBytes + len > this.#rxSize) break;
      this.#queue.shift();
      this.#inFlight.push({ ...next, len });
      this.#inFlightBytes += len;
      this.sim.write(next.text + '\n');
      if (!next.program) this.onLine?.(next.text, 'tx');
    }
  }

  #ack(error) {
    const line = this.#inFlight.shift();
    if (!line) return;
    this.#inFlightBytes -= line.len;
    line.resolve?.(error);
    if (line.program && this.program) {
      const p = this.program;
      p.acked++;
      if (error) {
        p.errors++;
        this.onLine?.(`${line.text}  →  ${error}`, 'error');
      }
      if (p.acked >= p.lines.length) {
        p.running = false;
        p.done = true;
      }
      this.onProgram?.(p);
    }
    this.#pump();
  }

  #receive(line) {
    if (!line) return;

    if (line.startsWith('<')) return this.#parseStatus(line);

    if (line === 'ok') return this.#ack(null);

    if (line.startsWith('error:')) {
      const quiet = this.#inFlight[0]?.program;
      if (!quiet) this.onLine?.(line, 'error');
      return this.#ack(line);
    }

    if (line.startsWith('ALARM:')) {
      this.onLine?.(line, 'alarm');
      return;
    }

    if (line.startsWith('GrblHAL') || line.startsWith('Grbl ')) {
      this.#flush();
      this.onLine?.(line, 'rx');
      this.onReset?.();
      return;
    }

    let m;
    if ((m = line.match(/^\$(\d+)=(.*)$/))) {
      this.settings.set(+m[1], m[2]);
      this.onSettings?.(this.settings);
    } else if ((m = line.match(/^\[OPT:[^,]*,\d+,(\d+)/))) {
      this.#rxSize = +m[1] - 1;
    }

    this.onLine?.(line, line.startsWith('[MSG') ? 'msg' : 'rx');
  }

  #parseStatus(line) {
    const fields = line.slice(1, -1).split('|');
    const s = this.status;
    s.state = fields[0];
    s.pins = '';
    for (const f of fields.slice(1)) {
      const [key, value] = f.split(':');
      const nums = () => value.split(',').map(Number);
      switch (key) {
        case 'MPos': s.mpos = nums(); break;
        case 'WPos': s.mpos = nums().map((v, i) => v + s.wco[i]); break;
        case 'WCO': s.wco = nums(); break;
        case 'FS': [s.feed, s.rpm] = nums(); break;
        case 'F': [s.feed] = nums(); break;
        case 'Ov': s.ov = nums(); break;
        case 'Pn': s.pins = value; break;
      }
    }
    s.wpos = s.mpos.map((v, i) => v - s.wco[i]);
    this.onStatus?.(s);
  }
}
