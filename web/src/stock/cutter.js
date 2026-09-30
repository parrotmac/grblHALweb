// SPDX-License-Identifier: LGPL-3.0-or-later
// Runs the firmware's position samples through a Stock: every stretch of
// motion between two samples is a straight line of the tool tip (see SAMPLE
// in ../sim/samples.js), swept through the stock with the tool that was
// selected, and checked for what it shouldn't do.
//
// Findings, one per kind and program line (repeats are counted):
//   rapid    a rapid (G0) move cut material                         error
//   spindle  material was cut with the spindle stopped               error
//   shank    material stood above the flutes, in the shank's way     error
//   holder   the collet nut ran into the stock                       error
//   table    the tool tip went below the table (Z = 0)               warning
// plus, from the sender: firmware errors and alarms on a line.

import { SAMPLE, MOTION_RAPID } from '../sim/samples.js';
import { Stock } from './stock.js';
import { normalizeTool } from './tools.js';

// Collisions shallower than this are rounding (step resolution, a surface
// found by probing), not collisions.
export const TOLERANCE = 0.01;
const MAX_FINDINGS = 1000;

export const SEVERITY = Object.freeze({
  rapid: 'error', spindle: 'error', shank: 'error', holder: 'error', table: 'warning',
  alarm: 'error', error: 'error',
});

export class Cutter {
  #byKey = new Map();          // kind:line -> finding
  #changed = false;
  #previous = new Set();       // keys reported by the previous move, which a repeat continues

  // box: the stock (see Stock). tools: { [number]: spec } for the program's
  // T numbers; tool: the spec for any other number (T0, or one not in the
  // table). tipLength: the stick-out of the tool the machine was zeroed
  // with - the physical Z axis position is the collet face, and the tip is
  // this far below it. After a tool change the new tool is assumed touched
  // off (its tip lands where the old one did), as an operator would do.
  constructor(box, { resolution, tools = {}, tool, tipLength } = {}) {
    this.stock = new Stock(box, { resolution });
    this.setTools(tools, tool);
    this.tipLength = tipLength ?? this.defaultTool?.length ?? 0;
    this.findings = [];
    this.last = null;                  // tip of the previous sample
    this.time = 0;
    this.cutTime = 0;                  // simulated s spent removing material
  }

  setTools(tools = {}, tool) {
    this.tools = new Map();
    for (const [n, spec] of Object.entries(tools ?? {})) {
      const t = normalizeTool(spec);
      if (t && Number.isInteger(+n)) this.tools.set(+n, t);
    }
    if (tool !== undefined) this.defaultTool = normalizeTool(tool);
  }

  toolFor(number) {
    return this.tools.get(number) ?? this.defaultTool ?? this.tools.values().next().value ?? null;
  }

  addSamples(data, count, stride) {
    const A = SAMPLE.AXES;
    const nAxes = (stride - A) / 2;
    for (let s = 0; s < count; s++) {
      const o = s * stride;
      const tip = [data[o + A], data[o + A + 1], (nAxes > 2 ? data[o + A + 2] : 0) - this.tipLength];
      const time = data[o + SAMPLE.TIME];
      const prev = this.last;
      this.last = tip;
      if (prev && (prev[0] !== tip[0] || prev[1] !== tip[1] || prev[2] !== tip[2])) {
        this.#move(prev, tip, {
          time: this.time,
          line: data[o + SAMPLE.LINE],
          rapid: !!(data[o + SAMPLE.MOTION] & MOTION_RAPID),
          spindle: data[o + SAMPLE.RPM] !== 0,
          tool: data[o + SAMPLE.TOOL],
          dt: time - this.time,
        });
      }
      this.time = time;
    }
  }

  #move(p0, p1, m) {
    m.reported = new Set();
    this.#moveChecks(p0, p1, m);
    this.#previous = m.reported;
  }

  #moveChecks(p0, p1, m) {
    if (Math.min(p0[2], p1[2]) < -TOLERANCE) {
      const at = p0[2] < p1[2] ? p0 : p1;
      this.#report('table', m, -at[2], at, `the tool tip is ${fmt(-at[2])} mm below the table`);
    }
    const tool = this.toolFor(m.tool);
    if (!tool) return;
    const r = this.stock.cut(p0, p1, tool);
    if (r.shank && r.shank.depth > TOLERANCE) {
      this.#report('shank', m, r.shank.depth, r.shank.at, `material ${fmt(r.shank.depth)} mm above the flutes (${fmt(tool.fluteLength)} mm) hits the shank`);
    }
    if (r.holder && r.holder.depth > TOLERANCE) {
      this.#report('holder', m, r.holder.depth, r.holder.at, `the collet nut runs ${fmt(r.holder.depth)} mm into the stock (tool sticks out ${fmt(tool.length)} mm)`);
    }
    if (r.depth > 0) {
      this.cutTime += Math.max(0, m.dt);
      if (r.depth > TOLERANCE) {
        if (m.rapid) this.#report('rapid', m, r.depth, r.at, `a rapid move cuts ${fmt(r.depth)} mm deep`);
        if (!m.spindle) this.#report('spindle', m, r.depth, r.at, `cuts ${fmt(r.depth)} mm deep with the spindle stopped`);
      }
    }
  }

  // Firmware errors and alarms, from the sender.
  report(kind, { line = 0, time = this.time, message, at = this.last } = {}) {
    this.#report(kind, { line, time }, 0, at, message);
  }

  // count is how many separate times it happened: a finding that goes on over
  // consecutive moves (however finely the path was sampled) is one.
  #report(kind, m, depth, at, message) {
    const key = `${kind}:${m.line}`;
    const known = this.#byKey.get(key);
    const continued = this.#previous.has(key) && !!m.reported;
    m.reported?.add(key);
    this.#changed = true;
    if (known) {
      if (!continued) known.count++;
      if (depth > known.depth) Object.assign(known, { depth, at: at && [...at], message });
      return;
    }
    if (this.findings.length >= MAX_FINDINGS) return;
    const finding = { kind, severity: SEVERITY[kind], line: m.line, time: m.time, depth, at: at && [...at], message, count: 1 };
    this.#byKey.set(key, finding);
    this.findings.push(finding);
  }

  // All findings if any were added or updated since the last call, else null.
  takeFindings() {
    if (!this.#changed) return null;
    this.#changed = false;
    return this.findings;
  }

  get stats() {
    return {
      removed: this.stock.removed,
      cutTime: this.cutTime,
      time: this.time,
      resolution: this.stock.resolution,
      errors: this.findings.filter((f) => f.severity === 'error').length,
      warnings: this.findings.filter((f) => f.severity === 'warning').length,
    };
  }
}

const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
