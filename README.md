# grblHALweb

grblHAL compiled to WebAssembly, with a simulated MCU driver, running on a
single thread in the browser (or Node). The goal is a realistic machine
simulator with a three.js viewer.

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
pkg/             npm package @parrotmac/grblhal-web (see pkg/README.md)
  src/grblhal.js       GrblHAL: runs the firmware on the calling thread
  src/worker-client.js GrblHALWorker: the same API, firmware in a Web Worker
  src/worker.js        the worker entry point
  src/viewer/          MachineViewer (three.js), the ./viewer entry point
  firmware/            the two builds, copied here by CMake (not committed)
web/             demo app (Vite + three.js), uses the package through a link
  src/sender.js  character-counting G-code sender, status parsing
tools/           headless Node runner
```

## Build

```sh
direnv allow                      # or: nix develop
git submodule update --init
emcmake cmake -B build -G Ninja
cmake --build build               # build/grblhal-{jspi,asyncify}.{mjs,wasm}, copied to pkg/firmware
```

## Run in the browser

```sh
cd web && pnpm install && pnpm dev
```

The page loads the JSPI build where the engine supports it (Chrome,
Firefox) and the Asyncify build elsewhere. A fresh browser profile gets a
demo machine preset (300×200×80 mm, homing and hard/soft limits on, 24k
spindle, a G54 offset over the table); settings live in localStorage.

## The package

`pkg/` is published to GitHub Packages as `@parrotmac/grblhal-web`; its README
covers installing and using it. CI (`.github/workflows/package.yml`) builds the
firmware with this flake, runs a smoke test and packs the package on every
push. Pushing a tag that matches `pkg/package.json`'s version publishes it:

```sh
# bump pkg/package.json "version", commit, then
git tag v0.2.0 && git push origin v0.2.0
```

`npm pack` in `pkg/` makes the same tarball locally. Its prepack step writes
`firmware/build-info.json`, recording the grblHALweb and grblHAL core commits
the firmware was built from.

## Run headless

```sh
node tools/run-headless.mjs -c '$I' -c '$$'
node tools/run-headless.mjs -t 1 -e build/nvs.bin -s samples.csv program.nc
```

`-t` speed (simulated s per wall s, `0` = as fast as possible), `-e` NVS
(settings) file, `-s` CSV of sampled machine position/state.

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
