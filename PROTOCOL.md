# postMessage protocol

The simulator is a standalone web app. Other pages drive it the way a sender
drives a controller over a serial port: they load the app in an iframe or a
window they open, connect over `postMessage`, write bytes to the simulated
UART and read its output back. This is protocol version **1**.

The app serves a dependency-free client for it at `client.js`, next to its
`index.html`. You can import it from there or copy it into your project.

```js
import { connect } from 'https://parrotmac.github.io/grblHALweb/client.js';

// <iframe src="https://parrotmac.github.io/grblHALweb/?layout=viewer">
const iframe = document.querySelector('iframe');
const sim = await connect(iframe.contentWindow);   // or a window.open() handle

sim.onLine = (line) => console.log(line);          // 'ok', '<Idle|MPos:...>', 'ALARM:1', ...
sim.write('$$\n');                                 // G-code and $ commands, text or bytes
sim.realtime('?');                                 // realtime byte: '?', '!', '~', 0x18, 0x85, ...
sim.speed = 0;                                     // simulated s per wall s, 0 = as fast as possible
sim.close();                                       // hand the controller back to the app
```

`connect(target, options)`:

| option | |
| --- | --- |
| `origin` | The app's origin. Defaults to the origin `client.js` was loaded from; required when you copy the file. |
| `samples` | Deliver position samples to `onSamples`. Default `false`. |
| `timeout` | ms to wait for the app. Default 30000. |

The client has `write(data)`, `realtime(byte)`, `speed`, `showProgram(text, name)`,
`setStock(box)`, `setTool(tool)`, `setTools(table)`, `setProbe(plate)`,
`setView({ program, stock })`, `simulate(text, { name, resolution })` (a
promise of the final report), `cancelSimulation()`, `exportStock(source)`,
`reboot({ factory })` and `close()`, plus the callbacks `onBytes`, `onData`,
`onLine`, `onClock`, `onSamples`, `onSpeed`, `onStarted`, `onCrash`,
`onFindings`, `onSimulation` and `onClose`. The messages below are the actual
API, so you can also do without the client.

## The app

| URL parameter | |
| --- | --- |
| `layout=viewer` | Only the machine view, with no top bar or side panel. Use it next to your own controls. |
| `firmware=jspi` / `asyncify` | Force a firmware build. The default picks JSPI where the engine supports it. |

While a client is connected, the app's own controls are disabled and it stops
polling status. The client owns the serial link, just like a single USB port
on real hardware. The app keeps parsing the output, so its DRO, console and
viewer still follow what the client does. When the client disconnects, the
app takes the link back.

Settings (NVS) persist in the app's `localStorage`, so they are shared by
everything that loads the app from the same origin. When the app runs on its
own, it applies a demo machine configuration to a factory-fresh controller.
It never does this while a client is connected.

## Handshake

Window messages. The type is in the `grblhal` field, so they stay out of the
way of anything else on the page.

1. When the app loads, it posts `{ grblhal: 'ready', protocol: 1 }` to its
   `parent` (in an iframe) or `opener` (in a window you opened, without
   `noopener`). The message has no content, so it is posted to `'*'`.
2. You may post `{ grblhal: 'hello' }` to the app window at any time. The app
   answers with the same `ready` message, addressed to your origin. This
   covers an app that loaded before you started listening.
3. When you get a `ready` whose `event.source` is the app window and whose
   `event.origin` is the app's origin, create a `MessageChannel` and post
   `{ grblhal: 'connect', protocol: 1, samples: false }` to the app with its
   origin as `targetOrigin`, transferring one port.
4. The app replies on the port with `connected`, or with `error` if it does
   not speak your protocol version.

Everything after that goes over the port. The app serves one client at a time:
a new `connect` replaces the current client, which is sent `disconnected`.

## Messages over the port

Each message is an object with a `type`.

### Client to app

| type | fields | |
| --- | --- | --- |
| `write` | `data`: string or Uint8Array | Bytes for the UART, e.g. `'G0 X10\n'`. |
| `realtime` | `byte`: 0-255 | One realtime command byte, e.g. `0x3f` (`?`), `0x21` (`!`), `0x7e` (`~`), `0x18` (soft reset), `0x85` (jog cancel). |
| `speed` | `value`: number | Simulated seconds per wall second. `0` = as fast as possible. |
| `program` | `text`: string or null, `name`?: string | Show a program preview in the machine view at grblHAL's work origin. `null` clears it. This does not send anything to the controller. |
| `reboot` | `factory`?: boolean | Power cycle the controller. With `factory`, its saved settings are erased first. |
| `stock` | `box`: `{ min: [x, y, z], max: [x, y, z] }` or null | The workpiece on the machine, in physical coordinates (see below). The machine view draws it where it is, whatever the work origin, and the probe input sees its top. The machine cuts it (see [Stock simulation](#stock-simulation)); sending it again puts back an uncut one. `null` takes it off. |
| `tool` | `tool`: a tool (see below) or null | The tool in the collet: the one used whenever the program's tool number isn't in the `tools` table (including T0, before any M6). Its `length` is how far its tip sticks out below the collet face. `null` puts the default back: a flat 3.175 mm end mill, 22 mm long. |
| `tools` | `tools`: `{ [number]: tool }` or null | The tool table, for programs that change tools (T*n* M6). Replaces the previous one; `null` empties it. Only for the connected client: the app's own table comes back when it disconnects. |
| `simulate` | `text`: string, `name`?: string, `resolution`?: number | Runs the program on a separate controller against the stock, as fast as it will go, and reports `simulation` messages. See [Stock simulation](#stock-simulation). A new one replaces a running one. |
| `cancelSimulation` | | Stops a running simulation. |
| `exportStock` | `source`?: `'live'` (default) or `'simulation'` | Asks for a stock's heightfield; answered with `stockExport`. |
| `probe` | `plate`: number or null | A touch plate this thick lies on top of whatever is under the tool: the probe input triggers when the tool tip reaches the stock's top (or the table, beside it) plus the plate. `null` or 0: the tip itself touches the surface. |
| `view` | `program`?: boolean, `stock`?: `'live'` or `'simulation'` | Show or hide the program preview in the machine view (it's shown until told otherwise); show the stock as the machine cut it, or as the last simulation did. |
| `disconnect` | | Give the link back to the app. |

### App to client

| type | fields | |
| --- | --- | --- |
| `connected` | `protocol`, `running`, `variant`, `speed`, `source`, `features` | Sent first. `features`: the optional messages this app understands (`'stock'`, `'tool'`, `'probe'`, `'view'`, `'tools'`, `'cutting'` for live cutting and `findings`, `'simulate'` for `simulate` and `cancelSimulation`, `'exportStock'`); an app without the field understands none of them. `running`: the firmware is booted. `variant`: `'jspi'` or `'asyncify'`, or null until booted. `source`: `{ repo, commit, dirty, core }`, the grblHALweb and grblHAL core commits the app was built from (`dirty`: with local changes; never for CI builds). |
| `started` | `variant` | The firmware booted, either at load or after `reboot`. grblHAL's own `GrblHAL ...` banner follows in `serial`. |
| `serial` | `bytes`: Uint8Array | Raw UART output. |
| `clock` | `time`: number | Simulated seconds, at every firmware yield (about 60 per second). |
| `samples` | `data`: Float64Array, `count`, `stride` | Position samples, only if you connected with `samples: true`. See below. |
| `speed` | `value` | The speed was changed from the app's own UI. |
| `crashed` | `message` | The firmware trapped, or failed to load. |
| `findings` | `source`: `'live'`, `findings` | What the live machine did to the stock that it shouldn't have: the whole list, whenever it changes. See [Findings](#findings). |
| `simulation` | `state`, `message`, `progress`, `findings`, `stats` | A simulation's progress, up to 10 times a second, and once more when it ends. `state`: `'starting'`, `'homing'`, `'running'`, then `'done'`, `'stopped'` (by an alarm), `'failed'` or `'cancelled'`. `message`: a sentence for people. `progress`: `{ acked, total, time }`, program lines acknowledged, of the total, and simulated seconds. `stats`: `{ removed (mm³), cutTime, time (s), resolution (mm), errors, warnings }`. |
| `stockExport` | `source`, `model`, `heights`, `findings`, `stats` | The heightfield asked for with `exportStock`, or `model: null` if there is no such stock. `model`: `{ min, max, nx, ny, cellX, cellY }`; `heights`: a Float32Array of `nx * ny` Z values, row by row from the front left corner, each the top of the material over that cell's centre. |
| `disconnected` | `reason` | The connection ended: another client connected, or the app closed. |
| `error` | `message` | The connection was refused during the handshake. |

The serial link runs at 115200 baud in simulated time. grblHAL reports a 1024
byte RX buffer in `[OPT:...]`, which character-counting senders can use.

### The physical machine

The simulated machine has its own physical coordinates, in mm: X and Y from
the minimum end of travel (the front left, with the default homing
direction), and Z up from the table, at Z = 0. The Z axis position is the
collet face; the tool tip is the tool's `length` below it. So grblHAL's
machine position is the collet face's, while work coordinates set by probing
or zeroing on the workpiece are the tip's, as on a real machine: after
changing to a tool of a different length, Z has to be zeroed again.

Once homed, with the default homing direction (towards `+`, `$23=0`) and
without `$22` "force origin", the physical position is grblHAL's machine
position plus the travel (`$130`-`$132`). So a work offset that puts work Z0
at the top of a stock `t` mm thick, for a tool `L` mm long, is
`G10 L2 P1 Z(t + L - $132)`.

The stock and the tool are drawn in the machine view and are what the probe
input sees, and the machine cuts the stock: see
[Stock simulation](#stock-simulation).

### Position samples

The firmware takes a sample every simulated millisecond while the machine is
moving, and on every change of state, spindle or coolant. Each sample is
`stride` doubles:

| index | |
| --- | --- |
| 0 | simulated time, s |
| 1 | grblHAL `sys_state_t` bits (0 = idle) |
| 2 | spindle rpm, negative = counter-clockwise, 0 = off |
| 3 | coolant mask: 1 = flood, 2 = mist |
| 4 | homed axes mask |
| 5 … 5+N-1 | physical axis positions, mm, integrated from the step/dir outputs (0 = minimum end of travel; Z is the collet face) |
| 5+N … | grblHAL machine positions (MPos), mm |

N = (stride - 5) / 2.

## Stock simulation

The stock on the machine is cut by the machine's actual motion: the tool tip's
path as integrated from the firmware's step and direction outputs, after
grblHAL's planner, arc segmentation, acceleration, offsets and overrides have
done their work. So it shows what this controller will do with the program,
not what a G-code interpreter thinks it should.

The stock is a heightfield: a grid over its X-Y extent (about 1024 cells along
its longer side unless `resolution` says otherwise), each cell holding the top
of the material there. That represents anything a 3-axis machine can cut, to
the precision of a cell; it can't represent undercuts.

- **Live**: once a `stock` is set, whatever the machine does cuts it:
  jogging, homing, streaming a program. Collisions are reported as `findings`.
- **`simulate`**: runs the program on a second, independent controller with
  the same settings and work offsets (as saved, so G92 and tool length
  offsets aren't carried over), as fast as it will go, without touching the
  live machine. It homes the machine if homing is enabled (or unlocks it),
  numbers every line with its line in `text` (replacing any N words), and
  does what an operator would: resumes after M0/M1 pauses and tool changes.
  It stops at an alarm. Its stock is separate from the live one; `view`
  switches the machine view between them.

Tools, mm and degrees: `diameter`, `length` (stick-out below the collet
face), `shape` (`'flat'`, `'ball'`, `'bull'` or `'v'`), `angle` (V bits,
included, default 90), `tipDiameter` (V bits, default 0), `cornerRadius`
(bull nose), `fluteLength` (default: the whole stick-out) and `shankDiameter`
(default: the diameter).

The machine is zeroed with the tool in the collet (`tool`): its tip is its
`length` below the collet face. After a tool change the new tool is assumed
touched off, so its tip lands where the old one's did; its own `length` still
counts for whether the collet nut clears the stock.

### Findings

Each finding is `{ kind, severity, line, time, depth, at, message, count }`:
one per kind and program line, with `count` repeats. `line` is the program
line (0 when motion isn't from a numbered line), `time` the simulated seconds
when it first happened, `depth` how far into the material in mm, `at` the
physical position [x, y, z] where it was deepest.

| kind | severity | |
| --- | --- | --- |
| `rapid` | error | A rapid (G0) move cut material. |
| `spindle` | error | Material was cut with the spindle stopped. |
| `shank` | error | Material stood above the flutes, where the shank passes. |
| `holder` | error | The collet nut ran into the stock: the tool doesn't stick out far enough. |
| `table` | warning | The tool tip went below the table (Z = 0). |
| `alarm` | error | The controller raised an alarm (a simulation stops there). |
| `error` | error | The controller answered a line with an error. |

Moves shallower than 0.01 mm into the material aren't collisions: that's
the step resolution, or a surface found by probing.

## Example

`examples/embed.html` in the app (`web/public/examples/embed.html` in this
repository) embeds the app in an iframe, can also open it in a separate
window, and drives it from a few buttons and a command line.
