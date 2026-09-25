// three.js view of the simulated machine. Everything lives in physical machine
// coordinates (mm, 0 = minimum end of travel, Z up) as reported by the
// firmware's motor step counters; the program preview is placed at the work
// origin grblHAL is currently using.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const TRAIL_MIN_STEP_MM = 0.01;

export class Viewer {
  constructor(container) {
    this.container = container;
    this.envelope = [200, 200, 200];
    this.rpm = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

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

    this.theme = {};
    this.applyTheme();

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.setEnvelope(this.envelope);
    this.fit();

    this.renderer.setAnimationLoop((t) => this.#frame(t));
  }

  // Colors come from CSS custom properties so the scene follows the page theme.
  applyTheme() {
    const css = getComputedStyle(this.container);
    const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || '#888');
    this.theme = {
      background: color('--viewport-bg'),
      grid: color('--grid'),
      gridMajor: color('--grid-major'),
      envelope: color('--envelope'),
      preview: color('--path-preview'),
      rapid: color('--path-rapid'),
      cut: color('--path-cut'),
      travel: color('--path-travel'),
    };
    this.scene.background = this.theme.background;
    this.setEnvelope(this.envelope);
    if (this.previewLines) this.previewLines.material.color = this.theme.preview;
    if (this.previewRapids) this.previewRapids.material.color = this.theme.rapid;
  }

  setEnvelope(travel) {
    this.envelope = travel.map((t) => (t > 0 ? t : 200));
    const [x, y, z] = this.envelope;

    this.machine.clear();

    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)),
      new THREE.LineBasicMaterial({ color: this.theme.envelope, transparent: true, opacity: 0.6 }),
    );
    box.position.set(x / 2, y / 2, z / 2);
    this.machine.add(box);

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(x, y),
      new THREE.MeshStandardMaterial({ color: this.theme.background.clone().offsetHSL(0, 0, 0.04), roughness: 0.9 }),
    );
    table.position.set(x / 2, y / 2, -0.05);
    this.machine.add(table);

    // 10 mm grid, every 50 mm emphasised
    const minor = [], major = [];
    for (let gx = 0; gx <= x; gx += 10) (gx % 50 ? minor : major).push(gx, 0, 0, gx, y, 0);
    for (let gy = 0; gy <= y; gy += 10) (gy % 50 ? minor : major).push(0, gy, 0, x, gy, 0);
    for (const [points, color] of [[minor, this.theme.grid], [major, this.theme.gridMajor]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      this.machine.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
    }
  }

  fit() {
    const [x, y, z] = this.envelope;
    const center = new THREE.Vector3(x / 2, y / 2, z / 3);
    const d = Math.max(x, y, z) * 1.6;
    this.camera.position.set(center.x + d * 0.55, center.y - d * 0.85, center.z + d * 0.7);
    this.controls.target.copy(center);
    this.controls.update();
  }

  // Work origin in physical coordinates.
  setWorkOrigin(p) {
    this.workOrigin.position.set(p[0], p[1], p[2]);
    if (this.preview) this.preview.position.copy(this.workOrigin.position);
  }

  setProgram(parsed) {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview.traverse((o) => o.geometry?.dispose());
    }
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

    this.previewLines = new THREE.LineSegments(split(false), new THREE.LineBasicMaterial({ color: this.theme.preview, transparent: true, opacity: 0.55 }));
    this.previewRapids = new THREE.LineSegments(split(true), new THREE.LineDashedMaterial({ color: this.theme.rapid, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.5 }));
    this.previewRapids.computeLineDistances();
    this.preview.add(this.previewLines, this.previewRapids);
    this.previewProvisional = undefined;
    this.scene.add(this.preview);
  }

  clearTrail() {
    this.trail.count = 0;
    this.trail.geometry.setDrawRange(0, 0);
    this.trail.last = null;
  }

  // data: Float64Array of samples (see SAMPLE_STRIDE in src/sim.c):
  // t, state, rpm, coolant, homed mask, physical xyz..., grbl mpos xyz...
  addSamples(data, count, stride) {
    const A = 5;
    const nAxes = (stride - A) / 2;
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const p = [data[o + A], data[o + A + 1], nAxes > 2 ? data[o + A + 2] : 0];
      const cutting = data[o + 2] !== 0;
      this.#appendTrail(p, cutting);
      this.rpm = data[o + 2];
      this.coolant = data[o + 3];
      this.homed = data[o + 4];
      this.nAxes = nAxes;
      this.position = p;
      // physical - grbl MPos: where grbl's machine origin sits on the machine
      this.mposOffset = [0, 1, 2].map((k) => (k < nAxes ? data[o + A + k] - data[o + A + nAxes + k] : 0));
    }
    if (this.position) this.tool.position.set(...this.position);
  }

  // A provisional preview (placed in the frame homing will establish) is drawn fainter.
  setPreviewProvisional(provisional) {
    if (this.previewProvisional === provisional || !this.preview) return;
    this.previewProvisional = provisional;
    this.previewLines.material.opacity = provisional ? 0.3 : 0.55;
    this.previewRapids.material.opacity = provisional ? 0.25 : 0.5;
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
    const c = cutting ? this.theme.cut : this.theme.travel;
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
    const dt = this.lastFrame ? (time - this.lastFrame) / 1000 : 0;
    this.lastFrame = time;

    const t = this.trail;
    if (t.dirtyFrom < t.count) {
      for (const name of ['position', 'color']) {
        const attr = t.geometry.attributes[name];
        attr.clearUpdateRanges();
        attr.addUpdateRange(t.dirtyFrom * 3, (t.count - t.dirtyFrom) * 3);
        attr.needsUpdate = true;
      }
      t.geometry.setDrawRange(0, t.count);
      t.dirtyFrom = t.count;
    }

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
