// SPDX-License-Identifier: LGPL-3.0-or-later
// three.js view of the simulated machine, fed by the firmware's position
// samples (onSamples). Everything lives in physical machine coordinates (mm,
// 0 = minimum end of travel, Z up) as integrated from the step/dir outputs;
// the program preview is placed at the work origin grblHAL is using.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SAMPLE } from '../sim/samples.js';
import { parseGcode } from './gcode.js';

export { parseGcode };

const TRAIL_MIN_STEP_MM = 0.01;
const STATE_ALARM = 1 << 0;   // sys_state_t bits, grbl/system.h
const STATE_HOMING = 1 << 2;

// Colours for a light and a dark page. Any CSS colour works in options.theme,
// including var(--token) references, which are resolved against the container.
export const LIGHT_THEME = Object.freeze({
  background: '#dfe3e8',
  grid: '#c9ced6',
  gridMajor: '#aeb5bf',
  envelope: '#7c8693',
  preview: '#5b6b80',
  rapid: '#7d8ea5',
  cut: '#e8741c',
  travel: '#2f6fd6',
});

export const DARK_THEME = Object.freeze({
  background: '#12161b',
  grid: '#1f252d',
  gridMajor: '#2d3540',
  envelope: '#4a5563',
  preview: '#7f93ad',
  rapid: '#56657a',
  cut: '#f08a35',
  travel: '#5b93f0',
});

export class MachineViewer {
  // Machine state from the latest sample
  position = null;        // physical tool position [x, y, z], mm
  rpm = 0;                // negative = counter-clockwise
  coolant = 0;
  state = 0;              // grblHAL sys_state_t bits
  homed = 0;              // homed axes mask

  #themeOption;
  #theme = {};
  #probe;
  #resizeObserver;
  #wco = [0, 0, 0];
  #homing = { travel: null, dirMask: 0, forceOrigin: false };
  #mposOffset = null;     // physical - grbl MPos
  #nAxes = 3;
  #previewProvisional;
  #lastFrame = 0;

  constructor(container, options = {}) {
    this.container = container;
    this.envelope = options.envelope ?? [200, 200, 200];
    this.#themeOption = options.theme;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    // Resolves CSS colours (including var() references) in the container's context.
    this.#probe = document.createElement('span');
    this.#probe.style.display = 'none';
    container.appendChild(this.#probe);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 10000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(300, -200, 500);
    this.scene.add(sun);

    this.machine = new THREE.Group();
    this.scene.add(this.machine);

    this.workOrigin = new THREE.Group();
    this.workOrigin.add(new THREE.AxesHelper(12));
    this.scene.add(this.workOrigin);

    this.#buildTool();
    this.#buildTrail();
    this.#resolveTheme();
    this.setEnvelope(this.envelope);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(container);
    this.#resize();
    this.fit();

    this.renderer.setAnimationLoop((t) => this.#frame(t));
  }

  // Replaces the theme (partial themes fall back to the light/dark default), or
  // re-resolves the current one, e.g. after the page's colour scheme changed.
  setTheme(theme = this.#themeOption) {
    this.#themeOption = theme;
    this.#resolveTheme();
    this.setEnvelope(this.envelope);
    if (this.previewLines) this.previewLines.material.color = this.#theme.preview;
    if (this.previewRapids) this.previewRapids.material.color = this.#theme.rapid;
  }

  // Machine travel in mm, [x, y, z]; draws the envelope, table and grid.
  setEnvelope(travel) {
    this.envelope = travel.map((t) => (t > 0 ? t : 200));
    const [x, y, z] = this.envelope;

    disposeTree(this.machine);
    this.machine.clear();

    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)),
      new THREE.LineBasicMaterial({ color: this.#theme.envelope, transparent: true, opacity: 0.6 }),
    );
    box.position.set(x / 2, y / 2, z / 2);
    this.machine.add(box);

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(x, y),
      new THREE.MeshStandardMaterial({ color: this.#theme.background.clone().offsetHSL(0, 0, 0.04), roughness: 0.9 }),
    );
    table.position.set(x / 2, y / 2, -0.05);
    this.machine.add(table);

    // 10 mm grid, every 50 mm emphasised
    const minor = [], major = [];
    for (let gx = 0; gx <= x; gx += 10) (gx % 50 ? minor : major).push(gx, 0, 0, gx, y, 0);
    for (let gy = 0; gy <= y; gy += 10) (gy % 50 ? minor : major).push(0, gy, 0, x, gy, 0);
    for (const [points, color] of [[minor, this.#theme.grid], [major, this.#theme.gridMajor]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      this.machine.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
    }
  }

  // Takes grblHAL settings as reported by $$ ($130-$132 travel, $22 homing
  // flags, $23 homing direction), as a Map or object keyed by setting number.
  // Returns true if the travel, and so the envelope, changed.
  applySettings(settings) {
    const get = (n) => {
      const v = settings instanceof Map ? (settings.get(n) ?? settings.get(String(n))) : (settings[n] ?? settings[String(n)]);
      return v === undefined ? undefined : parseFloat(v);
    };
    const travel = [130, 131, 132].map((n) => Math.abs(get(n) ?? NaN));
    if (get(22) !== undefined) this.#homing.forceOrigin = !!(get(22) & 8);
    if (get(23) !== undefined) this.#homing.dirMask = get(23);

    if (travel.some((t) => !(t > 0))) return false;
    this.#homing.travel = travel;
    if (travel.join() === this.envelope.join()) return false;
    this.setEnvelope(travel);
    return true;
  }

  // The active work coordinate offset, as in a status report's WCO field.
  setWorkOffset(wco) {
    this.#wco = [0, 1, 2].map((i) => wco[i] ?? 0);
  }

  // Shows a program preview: G-code text, a parseGcode() result, or null to clear.
  setProgram(program) {
    if (this.preview) {
      this.scene.remove(this.preview);
      disposeTree(this.preview);
      this.preview = this.previewLines = this.previewRapids = null;
    }
    if (program == null) return;

    const parsed = typeof program === 'string' ? parseGcode(program) : program;
    this.preview = new THREE.Group();
    this.preview.position.copy(this.workOrigin.position);

    const split = (wantRapid) => {
      const out = [];
      for (let s = 0; s < parsed.rapid.length; s++) {
        if (!!parsed.rapid[s] === wantRapid) out.push(...parsed.positions.subarray(s * 6, s * 6 + 6));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
      return g;
    };

    this.previewLines = new THREE.LineSegments(split(false), new THREE.LineBasicMaterial({ color: this.#theme.preview, transparent: true, opacity: 0.55 }));
    this.previewRapids = new THREE.LineSegments(split(true), new THREE.LineDashedMaterial({ color: this.#theme.rapid, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.5 }));
    this.previewRapids.computeLineDistances();
    this.preview.add(this.previewLines, this.previewRapids);
    this.#previewProvisional = undefined;
    this.scene.add(this.preview);
  }

  // Frames the whole machine envelope.
  fit() {
    const [x, y, z] = this.envelope;
    const center = new THREE.Vector3(x / 2, y / 2, z / 3);
    const d = Math.max(x, y, z) * 1.6;
    this.camera.position.set(center.x + d * 0.55, center.y - d * 0.85, center.z + d * 0.7);
    this.controls.target.copy(center);
    this.controls.update();
  }

  clearTrail() {
    this.trail.count = 0;
    this.trail.geometry.setDrawRange(0, 0);
    this.trail.last = null;
  }

  // Feed it the firmware's samples: pass as onSamples, or call from yours.
  addSamples = (data, count, stride) => {
    const A = SAMPLE.AXES;
    const nAxes = (stride - A) / 2;
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const p = [data[o + A], data[o + A + 1], nAxes > 2 ? data[o + A + 2] : 0];
      this.#appendTrail(p, data[o + SAMPLE.RPM] !== 0);
      this.state = data[o + SAMPLE.STATE];
      this.rpm = data[o + SAMPLE.RPM];
      this.coolant = data[o + SAMPLE.COOLANT];
      this.homed = data[o + SAMPLE.HOMED];
      this.position = p;
      this.#nAxes = nAxes;
      // where grbl's machine origin sits on the physical machine
      this.#mposOffset = [0, 1, 2].map((k) => (k < nAxes ? data[o + A + k] - data[o + A + nAxes + k] : 0));
    }
    if (this.position) this.tool.position.set(...this.position);
  };

  // Stops rendering and releases the WebGL context and GPU resources.
  dispose() {
    this.renderer.setAnimationLoop(null);
    this.#resizeObserver.disconnect();
    this.controls.dispose();
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.#probe.remove();
  }

  // Work origin in physical coordinates = WCO + (physical - grbl MPos). Before
  // the machine is homed that frame is wherever it powered on, so while homing
  // is still required (alarm, not homed) show the program where it will run
  // once homed; during homing the frame is in flux, so leave it where it was.
  #updateWorkOrigin() {
    if (!this.#mposOffset || this.state & STATE_HOMING) return;

    const allHomed = this.homed === (1 << this.#nAxes) - 1;
    const provisional = !allHomed && !!(this.state & STATE_ALARM) && !!this.#homing.travel;
    const offset = provisional ? this.#homedFrameOffset() : this.#mposOffset;

    this.workOrigin.position.set(...this.#wco.map((w, i) => w + offset[i]));
    if (!this.preview) return;
    this.preview.position.copy(this.workOrigin.position);
    if (this.#previewProvisional !== provisional) {
      // A provisional preview (placed in the frame homing will establish) is drawn fainter.
      this.#previewProvisional = provisional;
      this.previewLines.material.opacity = provisional ? 0.3 : 0.55;
      this.previewRapids.material.opacity = provisional ? 0.25 : 0.5;
    }
  }

  // Where grbl's machine origin will sit once homed: limits_set_machine_positions()
  // in core puts it at physical = MPos + travel, except with "force origin"
  // ($22 bit 3) and a negative homing direction ($23), where the switch is MPos 0.
  #homedFrameOffset() {
    const { travel, dirMask, forceOrigin } = this.#homing;
    return travel.map((t, i) => (forceOrigin && dirMask & (1 << i) ? 0 : t));
  }

  #resolveTheme() {
    const base = matchMedia('(prefers-color-scheme: dark)').matches ? DARK_THEME : LIGHT_THEME;
    const theme = { ...base, ...this.#themeOption };
    const resolved = {};
    for (const [key, value] of Object.entries(theme)) {
      this.#probe.style.color = '';
      this.#probe.style.color = value;
      const computed = this.#probe.style.color ? getComputedStyle(this.#probe).color : '';
      resolved[key] = parseCssColor(computed) ?? new THREE.Color(base[key]);
    }
    this.#theme = resolved;
    this.scene.background = resolved.background;
  }

  #buildTool() {
    this.tool = new THREE.Group();

    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.8, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, metalness: 0.4, roughness: 0.6 });
    this.bitMaterial = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.9, roughness: 0.25 });

    const up = (mesh, z) => {
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = z;
      return mesh;
    };

    // Stacked from the tool tip up: cutter (0-22), collet nut (22-32), spindle
    // nose (32-40), spindle body (40-110). Flute on the cutter so rotation reads.
    const nut = up(new THREE.Mesh(new THREE.CylinderGeometry(12, 14, 10, 6), metal), 27);
    const nose = up(new THREE.Mesh(new THREE.CylinderGeometry(16, 13, 8, 40), metal), 36);
    const body = up(new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 70, 40), dark), 75);
    this.cutter = new THREE.Group();
    const shank = up(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 22, 24), this.bitMaterial), 11);
    const flute = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 12), dark);
    flute.position.z = 6;
    this.cutter.add(shank, flute);
    this.tool.add(body, nose, nut, this.cutter);

    this.coolantCone = new THREE.Mesh(
      new THREE.ConeGeometry(6, 14, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide }),
    );
    this.coolantCone.rotation.x = -Math.PI / 2;
    this.coolantCone.position.set(-10, 0, 10);
    this.coolantCone.visible = false;
    this.tool.add(this.coolantCone);

    this.scene.add(this.tool);
  }

  #buildTrail() {
    const capacity = 1 << 16;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.trail = { line: new THREE.Line(geometry, new THREE.LineBasicMaterial({ vertexColors: true })), geometry, capacity, count: 0, last: null, dirtyFrom: 0 };
    this.trail.line.frustumCulled = false;
    this.scene.add(this.trail.line);
  }

  #appendTrail(p, cutting) {
    const t = this.trail;
    if (t.last && t.lastCutting === cutting && Math.hypot(p[0] - t.last[0], p[1] - t.last[1], p[2] - t.last[2]) < TRAIL_MIN_STEP_MM) return;

    if (t.count === t.capacity) this.#growTrail();

    const pos = t.geometry.attributes.position.array;
    const col = t.geometry.attributes.color.array;
    const c = cutting ? this.#theme.cut : this.#theme.travel;
    pos.set(p, t.count * 3);
    col.set([c.r, c.g, c.b], t.count * 3);
    t.dirtyFrom = Math.min(t.dirtyFrom, t.count);
    t.count++;
    t.last = p;
    t.lastCutting = cutting;
  }

  #growTrail() {
    const t = this.trail;
    const grow = (attr) => {
      const next = new Float32Array(t.capacity * 2 * 3);
      next.set(attr.array);
      return new THREE.BufferAttribute(next, 3).setUsage(THREE.DynamicDrawUsage);
    };
    t.geometry.setAttribute('position', grow(t.geometry.attributes.position));
    t.geometry.setAttribute('color', grow(t.geometry.attributes.color));
    t.capacity *= 2;
    t.dirtyFrom = 0;
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #frame(time) {
    const dt = this.#lastFrame ? (time - this.#lastFrame) / 1000 : 0;
    this.#lastFrame = time;

    const t = this.trail;
    if (t.dirtyFrom < t.count) {
      for (const name of ['position', 'color']) {
        const attr = t.geometry.attributes[name];
        if (attr.addUpdateRange) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(t.dirtyFrom * 3, (t.count - t.dirtyFrom) * 3);
        } else {
          attr.updateRange = { offset: t.dirtyFrom * 3, count: (t.count - t.dirtyFrom) * 3 }; // three < r159
        }
        attr.needsUpdate = true;
      }
      t.geometry.setDrawRange(0, t.count);
      t.dirtyFrom = t.count;
    }

    this.#updateWorkOrigin();

    // Show rotation direction and roughly the speed, capped well below
    // the frame rate so it does not alias into standing still.
    if (this.rpm) {
      const visualRps = Math.sign(-this.rpm) * Math.min(Math.abs(this.rpm) / 60, 6);
      this.cutter.rotation.z += visualRps * 2 * Math.PI * dt;
    }
    this.bitMaterial.emissive?.setHex(this.rpm ? 0x3a1e05 : 0x000000);
    this.coolantCone.visible = !!this.coolant;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

function parseCssColor(css) {
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (m) return new THREE.Color(m[1] / 255, m[2] / 255, m[3] / 255).convertSRGBToLinear();
  const c = css.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (c) return new THREE.Color(+c[1], +c[2], +c[3]).convertSRGBToLinear();
  return null;
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) m?.dispose?.();
  });
}
