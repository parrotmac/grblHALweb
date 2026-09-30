// SPDX-License-Identifier: LGPL-3.0-or-later
// Draws a simulated stock (../stock/stock.js) as tiles of one shared grid,
// displaced in the vertex shader by a float texture of heights per tile.
//
// Vertex (u, v) of tile (tx, ty) is the centre of cell (tx·T + u·s - 1,
// ty·T + v·s - 1), where cells -1 and n are a ring at the stock's edge, at its
// bottom: that ring makes the side walls. A tile's texture holds heights for
// cells tx·T - 2 ... tx·T + T, one more on each side for normals (see
// Stock.takeDirtyTiles).
//
// s is the tile's level of detail: every cell (1) up close, every 2nd, 4th ...
// where cells are smaller than a pixel or so on screen (updateLod).

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  uniform sampler2D heights;
  uniform vec2 origin;     // cell index of vertex (0, 0)
  uniform float stride;    // cells per vertex
  uniform vec2 cells;      // nx, ny
  uniform vec2 cell;       // cell size, mm
  uniform vec2 stockMin;
  uniform vec2 stockMax;
  uniform float top;
  varying vec3 vNormal;
  varying float vDepth;
  varying vec3 vWorld;

  float heightAt(ivec2 k) { return texelFetch(heights, k, 0).r; }

  void main() {
    vec2 c = position.xy * stride;
    ivec2 k = ivec2(c) + 1;
    float h = heightAt(k);
    vec2 e = min(origin + c, cells);             // past the edge ring: fold onto it
    vec2 xy = clamp(stockMin + (e + 0.5) * cell, stockMin, stockMax);
    float dx = heightAt(k + ivec2(1, 0)) - heightAt(k - ivec2(1, 0));
    float dy = heightAt(k + ivec2(0, 1)) - heightAt(k - ivec2(0, 1));
    vNormal = normalize(vec3(-dx / (2.0 * cell.x), -dy / (2.0 * cell.y), 1.0));
    vDepth = top - h;
    vec4 world = modelMatrix * vec4(xy, h, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 stockColor;
  uniform vec3 cutColor;
  uniform vec3 deepColor;
  uniform float thickness;
  varying vec3 vNormal;
  varying float vDepth;
  varying vec3 vWorld;

  void main() {
    vec3 n = normalize(vNormal);
    // Untouched faces in the stock's colour, machined ones by depth.
    float cut = smoothstep(0.004, 0.02, vDepth);
    vec3 base = mix(stockColor, mix(cutColor, deepColor, clamp(vDepth / max(thickness, 0.001), 0.0, 1.0)), cut);
    float light = 0.42
      + 0.48 * max(dot(n, normalize(vec3(0.35, -0.55, 0.75))), 0.0)
      + 0.22 * max(dot(n, normalize(vec3(-0.6, 0.4, 0.5))), 0.0)
      + 0.12 * n.z;
    gl_FragColor = vec4(base * light, 1.0);
    #include <colorspace_fragment>
  }
`;

const STRIDES = [1, 2, 4, 8, 16];
const TARGET_PX = 1.5;          // aim for vertices about this far apart on screen

// (N + 1)² vertices at integer (u, v), for N = T / stride; tiles share them.
function grid(N) {
  const positions = new Float32Array((N + 1) * (N + 1) * 3);
  for (let v = 0, p = 0; v <= N; v++) for (let u = 0; u <= N; u++, p += 3) positions.set([u, v, 0], p);
  const index = new Uint32Array(N * N * 6);
  for (let v = 0, q = 0; v < N; v++) {
    for (let u = 0; u < N; u++, q += 6) {
      const a = v * (N + 1) + u, b = a + 1, c = a + N + 1, d = c + 1;
      index.set([a, b, d, a, d, c], q);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

export class StockMesh {
  #frustum = new THREE.Frustum();
  #matrix = new THREE.Matrix4();

  constructor(model) {
    this.model = model;
    const T = model.tile;
    this.size = T + 3;
    this.group = new THREE.Group();
    this.geometries = new Map(STRIDES.filter((s) => T % s === 0).map((s) => [s, grid(T / s)]));

    const thickness = model.max[2] - model.min[2];
    this.uniforms = {
      cells: { value: new THREE.Vector2(model.nx, model.ny) },
      cell: { value: new THREE.Vector2(model.cellX, model.cellY) },
      stockMin: { value: new THREE.Vector2(model.min[0], model.min[1]) },
      stockMax: { value: new THREE.Vector2(model.max[0], model.max[1]) },
      top: { value: model.max[2] },
      thickness: { value: thickness },
      stockColor: { value: new THREE.Color(0xd9b27c) },
      cutColor: { value: new THREE.Color(0xf1dcb8) },
      deepColor: { value: new THREE.Color(0xb98a52) },
    };

    this.tiles = [];
    for (let ty = 0; ty < model.tilesY; ty++) {
      for (let tx = 0; tx < model.tilesX; tx++) {
        const texture = new THREE.DataTexture(new Float32Array(this.size * this.size).fill(model.max[2]), this.size, this.size, THREE.RedFormat, THREE.FloatType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        const stride = { value: 1 };
        const material = new THREE.ShaderMaterial({
          vertexShader,
          fragmentShader,
          uniforms: {
            ...this.uniforms,
            heights: { value: texture },
            origin: { value: new THREE.Vector2(tx * T - 1, ty * T - 1) },
            stride,
          },
        });
        const mesh = new THREE.Mesh(this.geometries.get(1), material);
        mesh.frustumCulled = false; // the grid's own bounds are not where it is drawn: see updateLod
        this.group.add(mesh);
        // The tile's extent on the machine, for culling and detail.
        const x0 = model.min[0] + (tx * T - 1) * model.cellX, y0 = model.min[1] + (ty * T - 1) * model.cellY;
        const bounds = new THREE.Box3(
          new THREE.Vector3(Math.max(model.min[0], x0), Math.max(model.min[1], y0), model.min[2]),
          new THREE.Vector3(Math.min(model.max[0], x0 + T * model.cellX), Math.min(model.max[1], y0 + T * model.cellY), model.max[2]),
        );
        this.tiles.push({ texture, material, mesh, stride, bounds });
      }
    }
  }

  // Per tile: hide it if it's out of view, else draw every cell only where
  // cells are big enough on screen to tell apart. Call before rendering.
  updateLod(camera, viewportHeight) {
    this.#matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#matrix);
    const pxPerMmAt1 = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const cell = Math.max(this.model.cellX, this.model.cellY);
    const center = new THREE.Vector3();
    for (const tile of this.tiles) {
      const visible = this.#frustum.intersectsBox(tile.bounds);
      tile.mesh.visible = visible;
      if (!visible) continue;
      const distance = Math.max(1e-3, tile.bounds.distanceToPoint(camera.position) || tile.bounds.getCenter(center).distanceTo(camera.position) * 0.5);
      const cellPx = (cell * pxPerMmAt1) / distance;
      let stride = 1;
      for (const s of this.geometries.keys()) if (s * cellPx <= TARGET_PX * 2) stride = s;
      if (tile.stride.value !== stride) {
        tile.stride.value = stride;
        tile.mesh.geometry = this.geometries.get(stride);
      }
    }
  }

  update(tiles) {
    for (const { tx, ty, data } of tiles) {
      const tile = this.tiles[ty * this.model.tilesX + tx];
      if (!tile || data.length !== this.size * this.size) continue;
      tile.texture.image.data = data;
      tile.texture.needsUpdate = true;
    }
  }

  dispose() {
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const { texture, material } of this.tiles) {
      texture.dispose();
      material.dispose();
    }
  }
}
