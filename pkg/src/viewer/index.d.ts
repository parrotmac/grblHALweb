import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Viewer colours. Any CSS colour works, including `var(--token)` references,
 * which are resolved against the container, so the scene can follow the page.
 */
export interface MachineViewerTheme {
  background: string;
  grid: string;
  gridMajor: string;
  envelope: string;
  /** Program preview, feed moves */
  preview: string;
  /** Program preview, rapids */
  rapid: string;
  /** Tool trail with the spindle on */
  cut: string;
  /** Tool trail with the spindle off */
  travel: string;
}

export const LIGHT_THEME: Readonly<MachineViewerTheme>;
export const DARK_THEME: Readonly<MachineViewerTheme>;

export interface MachineViewerOptions {
  /** Colours; missing ones come from LIGHT_THEME or DARK_THEME, per prefers-color-scheme. */
  theme?: Partial<MachineViewerTheme>;
  /** Initial machine travel [x, y, z] in mm, until applySettings() has $130-$132. Default 200 on each axis. */
  envelope?: [number, number, number];
}

/** A parsed program, as returned by parseGcode(). */
export interface ParsedProgram {
  /** Segment endpoints in work coordinates: x0 y0 z0 x1 y1 z1 per segment. */
  positions: Float32Array;
  /** Per segment: 1 for a rapid (G0). */
  rapid: Uint8Array;
  /** Per segment: the 0-based source line. */
  lineOf: Uint32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

/**
 * Parses G-code for the preview: G0-G3 (arcs in the XY plane), G90/G91, G20/G21.
 * Everything else is ignored; the firmware is the authority on the real motion.
 */
export function parseGcode(text: string): ParsedProgram;

/**
 * three.js view of the simulated machine: envelope, table, spindle, the tool's
 * trail, and a program preview at grblHAL's work origin. Feed it the firmware's
 * position samples through addSamples.
 */
export class MachineViewer {
  constructor(container: HTMLElement, options?: MachineViewerOptions);

  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Machine travel [x, y, z] in mm. */
  readonly envelope: [number, number, number];

  /** Physical tool position [x, y, z] in mm from the latest sample (0 = minimum end of travel). */
  readonly position: [number, number, number] | null;
  /** Spindle rpm from the latest sample; negative = counter-clockwise. */
  readonly rpm: number;
  readonly coolant: number;
  /** grblHAL sys_state_t bits from the latest sample. */
  readonly state: number;
  /** Homed axes mask from the latest sample. */
  readonly homed: number;

  /** Position samples from GrblHAL / GrblHALWorker's onSamples. Bound, so it can be passed directly. */
  readonly addSamples: (data: Float64Array, count: number, stride: number) => void;

  /**
   * grblHAL settings as reported by $$: $130-$132 (travel), $22 (homing flags)
   * and $23 (homing direction). Returns true if the envelope changed.
   */
  applySettings(settings: Map<number | string, string | number> | Record<number | string, string | number>): boolean;
  /** The active work coordinate offset (a status report's WCO field). */
  setWorkOffset(wco: ArrayLike<number>): void;
  /** Shows a program preview from G-code text or a parseGcode() result; null clears it. */
  setProgram(program: string | ParsedProgram | null): void;
  /** Machine travel [x, y, z] in mm. applySettings() calls this. */
  setEnvelope(travel: [number, number, number]): void;
  /** Replaces the theme, or re-resolves the current one (e.g. after the page's colour scheme changed). */
  setTheme(theme?: Partial<MachineViewerTheme>): void;
  /** Frames the whole machine envelope. */
  fit(): void;
  clearTrail(): void;
  /** Stops rendering and releases the WebGL context and GPU resources. */
  dispose(): void;
}
