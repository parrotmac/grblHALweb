// SPDX-License-Identifier: LGPL-3.0-or-later
// The stock as a heightfield: a grid over its XY extent, each cell holding
// the Z of the material's top there. That is exact for what a 3-axis machine
// can cut (it cannot undercut), and its precision is the cell size.
//
// Everything is in physical machine coordinates, mm: X and Y from the minimum
// end of travel, Z up from the table. Positions passed in are the tool tip's.

import { HOLDER_RADIUS, toolProfile } from './tools.js';

export const TILE = 128;                // cells per side of a render tile
const EPS = 1e-4;                       // mm: smaller changes are float noise, not cuts
const GOLDEN = (Math.sqrt(5) - 1) / 2;

export class Stock {
  // box: { min: [x, y, z], max: [x, y, z] }. resolution: cell size in mm;
  // by default the longer side gets about 1024 cells.
  constructor(box, { resolution } = {}) {
    this.min = [...box.min];
    this.max = [...box.max];
    const dx = Math.max(0.01, this.max[0] - this.min[0]);
    const dy = Math.max(0.01, this.max[1] - this.min[1]);
    const cell = resolution > 0 ? resolution : Math.max(dx, dy) / 1024;
    this.nx = Math.max(1, Math.min(4096, Math.round(dx / cell)));
    this.ny = Math.max(1, Math.min(4096, Math.round(dy / cell)));
    this.cellX = dx / this.nx;           // the cells tile the stock exactly
    this.cellY = dy / this.ny;
    this.top = this.max[2];
    this.bottom = this.min[2];
    this.z = new Float32Array(this.nx * this.ny).fill(this.top);
    this.tilesX = Math.ceil((this.nx + 1) / TILE);
    this.tilesY = Math.ceil((this.ny + 1) / TILE);
    this.dirty = new Uint8Array(this.tilesX * this.tilesY).fill(1);
    this.removed = 0;                    // mm³
  }

  get resolution() {
    return Math.max(this.cellX, this.cellY);
  }

  // The material's top at (x, y), or null outside the stock.
  heightAt(x, y) {
    const i = Math.floor((x - this.min[0]) / this.cellX);
    const j = Math.floor((y - this.min[1]) / this.cellY);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return null;
    return this.z[j * this.nx + i];
  }

  // Moves the tool tip in a straight line from p0 to p1 ([x, y, z]) and
  // removes what it sweeps. Before cutting, checks what the tool's shank and
  // the collet nut would run into. Returns what happened:
  //   { removed (mm³), depth (deepest cut, mm), at ([x, y, z] of it),
  //     shank, holder: null or { depth, at } }
  cut(p0, p1, tool) {
    const result = { removed: 0, depth: 0, at: null, shank: null, holder: null };
    const low = Math.min(p0[2], p1[2]);
    if (low >= this.top) return result; // above the stock: nothing to do (heights only go down)

    const z = this.z;
    const nx = this.nx;
    const cellArea = this.cellX * this.cellY;

    // The shank above the flutes, and the collet nut above the stick-out,
    // cut nothing: material there is a collision. Checked on the stock as it
    // is before this move.
    const R = tool.diameter / 2;
    const shankR = Math.max(tool.shankDiameter, 0) / 2;
    if (tool.fluteLength < tool.length && shankR > 0 && low + tool.fluteLength < this.top) {
      result.shank = this.#interference(p0, p1, shankR, tool.fluteLength, R);
    }
    if (low + tool.length < this.top) {
      result.holder = this.#interference(p0, p1, HOLDER_RADIUS, tool.length, tool.fluteLength >= tool.length ? R : shankR);
    }

    // Cutting through the bottom leaves nothing there: the column ends at the
    // stock's bottom (the depth still says how far into the material it went).
    const profile = toolProfile(tool);
    const bottom = this.bottom;
    let depth = 0, at = -1, atZ = 0, removed = 0;
    this.#sweep(p0, p1, profile, (idx, zmin) => {
      const d = z[idx] - zmin;
      if (d > EPS && z[idx] > bottom) {
        const left = Math.max(zmin, bottom);
        removed += (z[idx] - left) * cellArea;
        if (d > depth) {
          depth = d;
          at = idx;
          atZ = zmin;
        }
        z[idx] = left;
        return true;
      }
      return false;
    });
    if (at >= 0) {
      result.removed = removed;
      result.depth = depth;
      result.at = this.#cellPoint(at, atZ); // where the tool's surface got to
      this.removed += removed;
    }
    return result;
  }

  // Material standing above a flat-bottomed cylinder of radius r whose bottom
  // is `offset` above the tip, swept from p0 to p1. Within `clearedR` of the
  // path something below the cylinder (the flutes, or the shank) cuts or hits
  // the material first, so only what stands above the cylinder where it
  // first reaches the cell counts; farther out, anything above its lowest.
  #interference(p0, p1, r, offset, clearedR) {
    const z = this.z;
    let depth = 0, at = -1;
    const q0 = [p0[0], p0[1], p0[2] + offset];
    const q1 = [p1[0], p1[1], p1[2] + offset];
    this.#sweep(q0, q1, { radius: r, flat: true, h: () => 0 }, (idx, zmin, zentry, dist) => {
      const d = z[idx] - (dist <= clearedR ? zentry : zmin);
      if (d > depth) {
        depth = d;
        at = idx;
      }
      return false;
    });
    return depth > EPS ? { depth, at: this.#cellPoint(at, z[at]) } : null;
  }

  #cellPoint(idx, zv) {
    const i = idx % this.nx, j = (idx - i) / this.nx;
    return [this.min[0] + (i + 0.5) * this.cellX, this.min[1] + (j + 0.5) * this.cellY, zv];
  }

  // Visits every cell the tool touches moving from p0 to p1, with the lowest
  // Z the tool's surface reaches over that cell's centre during the move,
  // the Z of the tool's tip when it first gets there, and the closest the
  // tool's axis passes. visit(idx, zmin, zentry, dist) returns true if it
  // changed the cell.
  //
  // The tool surface over a cell is z(t) + h(r(t)) for t in [0, 1]: z is
  // linear, r(t) is the distance to a point moving on a line (convex), and h
  // is convex and non-decreasing, so the sum is convex: the minimum is found
  // in closed form for level moves, plunges and flat tools, and by golden
  // section search on ramps.
  #sweep(p0, p1, profile, visit) {
    const R = profile.radius;
    const R2 = R * R;
    const h = profile.h;
    const [ax, ay, z0] = p0;
    const dx = p1[0] - ax, dy = p1[1] - ay, dz = p1[2] - z0;
    const L2 = dx * dx + dy * dy;
    const level = Math.abs(dz) < 1e-9;
    const plunge = L2 < 1e-12;

    const cx0 = this.min[0] + 0.5 * this.cellX, cy0 = this.min[1] + 0.5 * this.cellY;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, p1[0]) - R - cx0) / this.cellX));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(ax, p1[0]) + R - cx0) / this.cellX));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, p1[1]) - R - cy0) / this.cellY));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, p1[1]) + R - cy0) / this.cellY));
    if (i0 > i1 || j0 > j1) return;

    let ci0 = Infinity, ci1 = -1, cj0 = Infinity, cj1 = -1; // changed cells
    const nx = this.nx;

    for (let j = j0; j <= j1; j++) {
      const wy = cy0 + j * this.cellY - ay;
      for (let i = i0; i <= i1; i++) {
        const wx = cx0 + i * this.cellX - ax;
        let zmin, zentry, dist;
        if (plunge) {
          const r2 = wx * wx + wy * wy;
          if (r2 > R2) continue;
          dist = Math.sqrt(r2);
          zentry = z0;
          zmin = Math.min(z0, p1[2]) + h(dist);
        } else {
          const tp = (wx * dx + wy * dy) / L2;           // closest approach on the line
          const perp2 = Math.max(0, wx * wx + wy * wy - tp * tp * L2);
          if (perp2 > R2) continue;
          const half = Math.sqrt((R2 - perp2) / L2);
          const t1 = Math.max(0, tp - half), t2 = Math.min(1, tp + half);
          if (t1 > t2) continue;
          const tc = Math.min(1, Math.max(0, tp));
          dist = Math.sqrt(perp2 + (tc - tp) * (tc - tp) * L2);
          zentry = z0 + t1 * dz;
          const g = (t) => z0 + t * dz + h(Math.sqrt(perp2 + (t - tp) * (t - tp) * L2));
          if (level) {
            zmin = g(Math.min(1, Math.max(0, tp)));
          } else if (profile.flat) {
            zmin = z0 + (dz > 0 ? t1 : t2) * dz;          // lowest point while over the cell
          } else {
            let a = t1, b = t2;
            let c = b - GOLDEN * (b - a), d = a + GOLDEN * (b - a);
            let gc = g(c), gd = g(d);
            for (let k = 0; k < 24 && b - a > 1e-6; k++) {
              if (gc < gd) {
                b = d; d = c; gd = gc;
                c = b - GOLDEN * (b - a); gc = g(c);
              } else {
                a = c; c = d; gc = gd;
                d = a + GOLDEN * (b - a); gd = g(d);
              }
            }
            zmin = Math.min(gc, gd, g(t1), g(t2));
          }
        }
        if (visit(j * nx + i, zmin, zentry, dist)) {
          if (i < ci0) ci0 = i;
          if (i > ci1) ci1 = i;
          if (j < cj0) cj0 = j;
          if (j > cj1) cj1 = j;
        }
      }
    }
    if (ci1 >= 0) this.#markDirty(ci0, ci1, cj0, cj1);
  }

  // Render tiles are indexed by vertex, one vertex per cell centre plus a
  // border ring (index -1 and n) at the stock's edge; a tile's texture also
  // holds its neighbours' cells for normals. A changed cell can show up in
  // tiles two cells away.
  #markDirty(i0, i1, j0, j1) {
    const tx0 = Math.max(0, Math.floor((i0 - 1) / TILE)), tx1 = Math.min(this.tilesX - 1, Math.floor((i1 + 3) / TILE));
    const ty0 = Math.max(0, Math.floor((j0 - 1) / TILE)), ty1 = Math.min(this.tilesY - 1, Math.floor((j1 + 3) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.dirty[ty * this.tilesX + tx] = 1;
  }

  // Every tile, on the next takeDirtyTiles(): for a renderer starting over.
  markAllDirty() {
    this.dirty.fill(1);
  }

  // What a renderer needs to know about the grid.
  get model() {
    return {
      min: this.min, max: this.max,
      nx: this.nx, ny: this.ny, cellX: this.cellX, cellY: this.cellY,
      tile: TILE, tilesX: this.tilesX, tilesY: this.tilesY,
    };
  }

  // The tiles changed since the last call, as { tx, ty, data }: (TILE + 3)²
  // heights for vertex indices tx * TILE - 2 ... tx * TILE + TILE (cells
  // outside the stock read as its bottom).
  takeDirtyTiles() {
    const out = [];
    const S = TILE + 3;
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const k = ty * this.tilesX + tx;
        if (!this.dirty[k]) continue;
        this.dirty[k] = 0;
        const data = new Float32Array(S * S);
        const bi = tx * TILE - 2, bj = ty * TILE - 2;
        for (let v = 0; v < S; v++) {
          const j = bj + v;
          const rowOk = j >= 0 && j < this.ny;
          for (let u = 0; u < S; u++) {
            const i = bi + u;
            data[v * S + u] = rowOk && i >= 0 && i < this.nx ? this.z[j * this.nx + i] : this.bottom;
          }
        }
        out.push({ tx, ty, data });
      }
    }
    return out;
  }
}
