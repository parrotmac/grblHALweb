# @parrotmac/grblhal-web

Real [grblHAL](https://github.com/grblHAL/core) CNC firmware, compiled to
WebAssembly with a simulated MCU and machine, for the browser (main thread or
a Web Worker) and Node, plus an optional three.js view of the machine. You talk to it the way you'd talk to a controller on a
serial port: write G-code and realtime bytes, read `ok`, status reports and
alarms back. Behind that byte stream it runs grblHAL's own planner,
acceleration, homing, and hard and soft limits, against a machine whose limit
switches are driven by the simulated motor positions.

Source, build instructions and the demo app: https://github.com/parrotmac/grblHALweb

## Install (GitHub Packages)

The package is public on GitHub's npm registry, which still needs a token to
install any package. Add an `.npmrc` next to your `package.json`:

```
@parrotmac:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

with any token that has `read:packages` in `GITHUB_TOKEN` (in GitHub Actions,
`secrets.GITHUB_TOKEN` with `permissions: packages: read`). Then:

```sh
npm install @parrotmac/grblhal-web
```

## Use

```js
import { GrblHALWorker } from '@parrotmac/grblhal-web';

const sim = new GrblHALWorker({
  onBytes: (bytes) => sender.receive(bytes),   // raw serial output
  nvsLoad: (dest) => restoreSettings(dest),    // optional: saved settings, return true if any
  nvsSave: (image) => saveSettings(image),     // optional: called when settings change
  onCrash: (err) => console.error(err),
});
await sim.start();        // loads the firmware in a worker and boots it

sim.write('$$\n');        // G-code and $ commands, as text or bytes
sim.realtime(0x3f);       // '?' status report; also '!', '~', 0x18 reset, ...
await sim.stop();         // saves settings, then terminates the worker
```

- **`GrblHALWorker`** runs the firmware in a dedicated Web Worker, so the
  page's rendering can't slow simulated time. Use it in browsers.
- **`GrblHAL`** runs it on the calling thread, for Node, or when you already
  are in a worker. It has the same API, plus `start(factory?)`, where
  `factory` comes from `loadFirmware()`.

Both pick the firmware build the engine supports: **JSPI** (native stack
switching; Chromium, Firefox, Node 24) or **Asyncify** (every engine, larger
and a little slower). Only the chosen one is downloaded: the `.wasm` is 226
KB (JSPI) or 366 KB (Asyncify), about 100 or 130 KB gzipped. Force one with
`new GrblHALWorker({ firmware: 'asyncify' })`.

### Options and callbacks

| | |
| --- | --- |
| `speed` | Simulated seconds per wall second; `0` = as fast as possible. Settable while running. Default `1`. |
| `onBytes(bytes)` | Serial output, raw. |
| `onData(text)` / `onLine(line)` | Serial output decoded, or split into lines without `\r\n`. |
| `onClock(seconds)` | Simulated time, at every yield (about 60 per second). |
| `samples`, `onSamples(data, count, stride)` | Position samples (Worker: set `samples: true`). See below. |
| `nvsLoad(dest)` / `nvsSave(image)` | Settings persistence: a 4 KB EEPROM image. `nvsLoad` fills `dest` and returns `true`, or returns `false` for a fresh controller. |
| `onCrash(error)` | The firmware trapped. |

The serial link runs at 115200 baud in simulated time, and grblHAL reports
`[OPT:...,1024]`: a 1024 byte RX buffer, for character-counting senders.

### Position samples

Every simulated millisecond while moving, and on every state, spindle or
coolant change, a sample of `stride` doubles: the fields in `SAMPLE` (time,
grblHAL state, spindle rpm with negative = CCW, coolant, homed axes), then N
physical axis positions and N grblHAL machine positions, in mm. The physical
positions are integrated from the step/dir outputs, with 0 at the minimum end
of travel; the firmware's `MPos` is only related to them once homed.

### The simulated machine

The machine powers on in the middle of its travel with Z raised. Limit
switches sit at the end of travel grblHAL homes towards (`$23`), wired as `$5`
says, at the travel set by `$130`–`$132`. So `$H`, pull-off, hard limits
(`$21`) and soft limits (`$20`) behave as on real hardware. A fresh controller
has grblHAL's defaults, e.g. 200 mm travel, 500 mm/min max rate, and homing off.

## Viewer

`@parrotmac/grblhal-web/viewer` is a three.js view of the simulated machine:
envelope, table and grid, a spindle that turns with the spindle state, the
path the tool actually took (from the position samples, coloured by spindle
on/off), and a preview of the program at grblHAL's work origin.

```js
import { GrblHALWorker } from '@parrotmac/grblhal-web';
import { MachineViewer } from '@parrotmac/grblhal-web/viewer';

const viewer = new MachineViewer(document.getElementById('machine'));
const sim = new GrblHALWorker({ samples: true, onSamples: viewer.addSamples, onBytes });
await sim.start();

// From your sender, as the controller reports them:
viewer.applySettings(settings);   // $$ output: $130-$132 travel, $22/$23 homing
viewer.setWorkOffset(status.wco); // a status report's WCO field
viewer.setProgram(gcodeText);     // or a parseGcode() result, or null

viewer.fit();
viewer.clearTrail();
viewer.dispose();                 // stops rendering, frees the WebGL context
```

The view sizes itself to its container. It works in physical machine
coordinates (mm, 0 = minimum end of travel, Z up). Until the machine is
homed, the preview is drawn faded where the program will run once homed.
`viewer.renderer`, `scene`, `camera` and `controls` are exposed for anything
else you want to add.

Colours follow `prefers-color-scheme` (`LIGHT_THEME`, `DARK_THEME`), or pass
your own. Any CSS colour works, including `var()` references, which are
resolved in the container's context so the scene can use the page's tokens:

```js
new MachineViewer(el, { theme: { background: 'var(--surface)', cut: '#e8741c' } });
viewer.setTheme();  // re-resolve after the page's colour scheme changes
```

three.js is a peer dependency (0.159 or later), needed only for the viewer.

## Bundlers

The Worker and `.wasm` files are referenced with `new URL(..., import.meta.url)`,
which Vite, webpack 5 and Parcel follow and emit as separate, lazily loaded
assets. In Vite, keep the package out of dependency pre-bundling, which would
break those relative URLs:

```js
// vite.config.js
export default {
  optimizeDeps: {
    exclude: ['@parrotmac/grblhal-web'],
    // With the viewer: pre-bundle its three.js imports up front, or the dev
    // server discovers them late and reloads the page.
    include: ['three', 'three/examples/jsm/controls/OrbitControls.js'],
  },
  worker: { format: 'es' },
  // When the package is linked (file: or link:) rather than installed,
  // resolve three from your app, so there is exactly one copy.
  resolve: { dedupe: ['three'] },
};
```

Load it lazily to keep it out of your main bundle until it's needed:

```js
const [{ GrblHALWorker }, { MachineViewer }] = await Promise.all([
  import('@parrotmac/grblhal-web'),
  import('@parrotmac/grblhal-web/viewer'),
]);
```

## License

GPL-3.0-or-later, like grblHAL. `firmware/build-info.json` records the exact
grblHALweb and grblHAL core commits each published build was made from; that
is the corresponding source for the `.wasm` files.
