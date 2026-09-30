# grblHALweb

grblHAL compiled to WebAssembly, with a simulated MCU driver, running on a
single thread in the browser (or Node). It is a standalone web app: a realistic
machine simulator with a three.js viewer, a console and a small G-code sender.

Other web apps, such as G-code senders and CAM tools, use it by loading it in
an iframe or a window they open. They drive it over `postMessage` the way they
would drive a controller over a serial port. [PROTOCOL.md](PROTOCOL.md)
describes the API, and the app serves a small client for it at `client.js`.

**Live:** https://parrotmac.github.io/grblHALweb/ (built from `master`), and
an [embedding example](https://parrotmac.github.io/grblHALweb/examples/embed.html).

## Layout

```
src/grbl/        grblHAL core (git submodule, kept pristine)
patches/core/    core bug fixes applied to a build-time copy of core, exposed by
                 wasm (strict indirect call signatures, 8-bit uint_fast8_t) -
                 candidates for upstreaming
src/             wasm driver, derived from grblHAL/Simulator
  sim.c          single threaded scheduler, pacing, host (JS) interface
  mcu.c          emulated timers / GPIO / UART
  driver.c       grblHAL HAL implementation on top of mcu.c
  serial.c       UART stream
web/             the app (Vite + three.js)
  src/main.js    UI wiring
  src/bridge.js  postMessage API, app side
  src/sender.js  character-counting G-code sender, status parsing
  src/simulation.js  background simulation of a program on a second controller
  src/sim/       firmware host: GrblHAL (calling thread), GrblHALWorker (Web Worker)
  src/stock/     stock simulation: heightfield, tool sweeps, collision checks (Web Worker)
  src/viewer/    MachineViewer (three.js), StockMesh
  test/          node --test 'web/test/*.test.js'
  src/firmware/  the two builds, copied here by CMake (not committed)
  public/client.js           postMessage API, embedder side
  public/examples/embed.html embedding example
tools/           headless Node runner
```

## Build

```sh
direnv allow                      # or: nix develop
git submodule update --init
emcmake cmake -B build -G Ninja
cmake --build build               # build/grblhal-{jspi,asyncify}.{mjs,wasm}, copied to web/src/firmware
```

## Run the app

```sh
cd web && pnpm install && pnpm dev
```

`pnpm build` writes a static site to `web/dist`, which can be served from
any path. It links to the grblHALweb and grblHAL core commits it was built
from. That is the corresponding source for the firmware it serves.

The page loads the JSPI build where the engine supports it (Chrome,
Firefox) and the Asyncify build elsewhere. A fresh browser profile gets a
demo machine preset (300×200×80 mm, homing and hard/soft limits on, 24k
spindle, a G54 offset over the table); settings live in localStorage.

`/examples/embed.html` drives the app from another page, in an iframe or a
separate window.

CI (`.github/workflows/build.yml`) builds the firmware with this flake,
runs a smoke test and the tests and builds the app on every push and pull
request, and deploys `master` to GitHub Pages.

## Run headless

```sh
node tools/run-headless.mjs -c '$I' -c '$$'
node tools/run-headless.mjs -t 1 -e build/nvs.bin -s samples.csv program.nc
```

`-t` speed (simulated s per wall s, `0` = as fast as possible), `-e` NVS
(settings) file, `-s` CSV of sampled machine position/state, `-f` fixture
JSON (tool, stock, touch plate).

With a stock in the fixture, `-r report.json` simulates the stock and checks
for collisions, and `-m heightmap.pgm` writes the cut stock; the exit status
is 3 if the program collides, so CAM output can be checked in CI:

```sh
node tools/run-headless.mjs -f fixture.json -r report.json -m part.pgm program.nc
```

## Stock simulation

Put a stock on the machine (the Stock panel, or the `stock` message) and
the machine cuts it, live, with whatever it does. **Simulate program** runs
the loaded program on a second controller with the same settings and work
offsets, as fast as it will go, without touching the live machine, and lists
what went wrong by program line: rapids into material, cutting with the
spindle stopped, material above the flutes or the collet nut hitting the
stock, the tool going through the table, alarms and errors.

It cuts with the machine's real motion. Every stepper block is a straight
line of the tool, so the firmware samples the position exactly where one
block ends and the next begins (`sim_motor_step()` in `src/sim.c`; a core
patch carries each block's line number and rapid flag to the stepper). The
tool's path is therefore exactly what grblHAL executed, with its planner,
arc segmentation, offsets and overrides. The stock is a heightfield of about
a thousand cells along its longer side, which is exact for anything a 3-axis
machine can cut, to the precision of a cell. Tools are radial profiles (flat,
ball, bull nose, V) swept along each move; see `web/src/stock/`.

## The simulated machine

Motor positions are integrated from the actual step/dir outputs, separately
from grblHAL's own `sys.position`, and drive limit switches at the end of
travel grblHAL homes towards (per `$23`, wired per `$5`). The machine powers
on mid-travel with Z raised, so homing, pull-off, hard and soft limits behave
as on real hardware. Position samples carry both the physical position and
grblHAL's MPos.

## How it runs on one thread

grblHAL's main loop never returns. Every wait in the core funnels through
`grbl.on_execute_realtime` or `hal.delay_ms`; the driver hooks both and calls
`sim_advance()`, which jumps the simulated clock to the next hardware event
(stepper timer, systick, UART byte slot) and runs its ISR. Foreground code
takes zero simulated time, and ISRs fire at the exact simulated tick they are
due.

`sim_advance()` compares simulated time with wall time. When it runs ahead, or
at least every 16 ms, it flushes serial output and position samples to JS and
calls `emscripten_sleep()`. That call is the only point where control returns
to the event loop: JSPI suspends the wasm stack there (Asyncify when built
that way). New input from JS is pulled when it resumes, so wasm is never
re-entered.

## License

grblHALweb's own code is licensed under the GNU Lesser General Public License,
version 3 or later ([COPYING.LESSER](COPYING.LESSER), which builds on the GPL
in [COPYING](COPYING)). That covers the web app, the firmware host, the viewer,
the sender, the postMessage client and the tools.

The firmware is licensed under the **GNU General Public License, version 3 or
later**. That covers the WebAssembly builds and everything compiled into them:
grblHAL core (`src/grbl`), the simulator driver derived from grblHAL/Simulator
(`src/driver.c`, `mcu.c`, `serial.c`, © Terje Io) and the rest of `src/`. See
[src/COPYING](src/COPYING). The built app serves this firmware to browsers,
and it links to the exact source commits it was built from.

Pages that embed the app talk to it only through `postMessage` messages
([PROTOCOL.md](PROTOCOL.md)), the way a sender talks to a controller over a
serial port. They don't include or link any of its code.
