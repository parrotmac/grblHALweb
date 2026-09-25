// Runs before `npm pack` / `npm publish`: checks the firmware builds are in
// firmware/ (CMake copies them there) and records which sources they were
// built from, so every published binary points at its corresponding source.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(pkgDir, '..');
const firmwareDir = join(pkgDir, 'firmware');
const files = ['grblhal-jspi.mjs', 'grblhal-jspi.wasm', 'grblhal-asyncify.mjs', 'grblhal-asyncify.wasm'];

const missing = files.filter((f) => !existsSync(join(firmwareDir, f)));
if (missing.length) {
  console.error(`prepack: missing ${missing.join(', ')} in pkg/firmware. Build the firmware first:`);
  console.error('  emcmake cmake -B build -G Ninja && cmake --build build');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
if (dirty && process.env.CI) {
  console.error('prepack: refusing to publish from a modified working tree');
  process.exit(1);
}

const { version, repository } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const info = {
  version,
  source: repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
  commit: git('rev-parse', 'HEAD') + (dirty ? '-dirty' : ''),
  grblhalCore: {
    source: 'https://github.com/grblHAL/core',
    commit: git('rev-parse', 'HEAD:src/grbl'),
  },
  emscripten: execFileSync('emcc', ['--version'], { encoding: 'utf8' }).split('\n')[0],
  sizes: Object.fromEntries(files.map((f) => [f, statSync(join(firmwareDir, f)).size])),
};
writeFileSync(join(firmwareDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`prepack: firmware from ${info.commit} (grblHAL core ${info.grblhalCore.commit.slice(0, 7)})`);
