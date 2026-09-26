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
`reboot({ factory })` and `close()`, plus the callbacks `onBytes`, `onData`,
`onLine`, `onClock`, `onSamples`, `onSpeed`, `onStarted`, `onCrash` and
`onClose`. The messages below are the actual API, so you can also do without
the client.

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
| `disconnect` | | Give the link back to the app. |

### App to client

| type | fields | |
| --- | --- | --- |
| `connected` | `protocol`, `running`, `variant`, `speed`, `source` | Sent first. `running`: the firmware is booted. `variant`: `'jspi'` or `'asyncify'`, or null until booted. `source`: `{ repo, commit, dirty, core }`, the grblHALweb and grblHAL core commits the app was built from (`dirty`: with local changes; never for CI builds). |
| `started` | `variant` | The firmware booted, either at load or after `reboot`. grblHAL's own `GrblHAL ...` banner follows in `serial`. |
| `serial` | `bytes`: Uint8Array | Raw UART output. |
| `clock` | `time`: number | Simulated seconds, at every firmware yield (about 60 per second). |
| `samples` | `data`: Float64Array, `count`, `stride` | Position samples, only if you connected with `samples: true`. See below. |
| `speed` | `value` | The speed was changed from the app's own UI. |
| `crashed` | `message` | The firmware trapped, or failed to load. |
| `disconnected` | `reason` | The connection ended: another client connected, or the app closed. |
| `error` | `message` | The connection was refused during the handshake. |

The serial link runs at 115200 baud in simulated time. grblHAL reports a 1024
byte RX buffer in `[OPT:...]`, which character-counting senders can use.

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
| 5 … 5+N-1 | physical axis positions, mm, integrated from the step/dir outputs (0 = minimum end of travel) |
| 5+N … | grblHAL machine positions (MPos), mm |

N = (stride - 5) / 2.

## Example

`examples/embed.html` in the app (`web/public/examples/embed.html` in this
repository) embeds the app in an iframe, can also open it in a separate
window, and drives it from a few buttons and a command line.
