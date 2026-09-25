export type FirmwareVariant = 'jspi' | 'asyncify';

/** Emscripten module factory for one firmware build. */
export type FirmwareFactory = (moduleArgs: object) => Promise<unknown>;

/** Whether this engine supports JSPI (WebAssembly.Suspending). */
export const jspiSupported: boolean;

/** Loads the firmware build to use: JSPI where supported, Asyncify otherwise. */
export function loadFirmware(
  variant?: FirmwareVariant | 'auto',
): Promise<{ factory: FirmwareFactory; variant: FirmwareVariant }>;

/** Callbacks and settings shared by GrblHAL and GrblHALWorker. */
export interface GrblHALOptions {
  /** Simulated seconds per wall second; 0 = as fast as possible. Default 1. */
  speed?: number;
  /** Raw serial output from the controller. */
  onBytes?: ((bytes: Uint8Array) => void) | null;
  /** Serial output decoded as UTF-8. */
  onData?: ((text: string) => void) | null;
  /** Complete output lines, without the line ending. */
  onLine?: ((line: string) => void) | null;
  /** Position samples; see SAMPLE for the layout. */
  onSamples?: ((data: Float64Array, count: number, stride: number) => void) | null;
  /** Simulated time in seconds, reported whenever the firmware yields. */
  onClock?: ((seconds: number) => void) | null;
  /** The firmware trapped or aborted. */
  onCrash?: ((error: unknown) => void) | null;
  /** Fill `dest` with saved settings (NVS) and return true, or return false for a fresh controller. */
  nvsLoad?: ((dest: Uint8Array) => boolean) | null;
  /** Called with the full NVS image whenever the controller saves settings. */
  nvsSave?: ((data: Uint8Array) => void) | null;
}

interface GrblHALHost {
  /** Simulated seconds per wall second; 0 = as fast as possible. */
  speed: number;
  /** Simulated seconds at the last yield. */
  readonly simTime: number;
  /** performance.now() when simTime was reported. */
  readonly simTimeWall: number;
  /** The firmware build in use, once started. */
  readonly variant: FirmwareVariant | null;
  /** Queues text or bytes for the controller's serial input. */
  write(data: string | Uint8Array): void;
  /** Sends one realtime command byte, e.g. 0x3f ('?'), 0x21 ('!'), 0x18 (reset). */
  realtime(byte: number): void;
  /** Stops the firmware after saving settings. The instance cannot be restarted. */
  stop(): Promise<void>;
}

/** Runs the firmware on the calling thread (main thread, a worker, or Node). */
export class GrblHAL implements GrblHALHost {
  constructor(options?: GrblHALOptions);
  speed: number;
  readonly simTime: number;
  readonly simTimeWall: number;
  readonly variant: FirmwareVariant | null;
  /** Bytes written but not yet read by the controller. */
  readonly inputPending: number;
  /** Boots the firmware; `factory` defaults to loadFirmware(). */
  start(factory?: FirmwareFactory, moduleArgs?: object): Promise<this>;
  write(data: string | Uint8Array): void;
  realtime(byte: number): void;
  stop(): Promise<void>;
}

export interface GrblHALWorkerOptions extends GrblHALOptions {
  /** Firmware build to load in the worker. Default 'auto'. */
  firmware?: FirmwareVariant | 'auto';
  /** Deliver position samples to onSamples. Default false. */
  samples?: boolean;
}

/** Runs the firmware in a dedicated Web Worker (browsers). */
export class GrblHALWorker implements GrblHALHost {
  constructor(options?: GrblHALWorkerOptions);
  speed: number;
  readonly simTime: number;
  readonly simTimeWall: number;
  readonly variant: FirmwareVariant | null;
  /** Creates the worker and boots the firmware; resolves once it is running. */
  start(): Promise<this>;
  write(data: string | Uint8Array): void;
  realtime(byte: number): void;
  /** Stops the firmware after saving settings, then terminates the worker. */
  stop(): Promise<void>;
}

/** Field offsets within one position sample. */
export const SAMPLE: {
  readonly TIME: 0;
  readonly STATE: 1;
  readonly RPM: 2;
  readonly COOLANT: 3;
  readonly HOMED: 4;
  readonly AXES: 5;
};
