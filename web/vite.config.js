// SPDX-License-Identifier: LGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

const REPO = 'https://github.com/parrotmac/grblHALweb';

// The commits the app and its firmware were built from. The deployed app
// serves the GPL grblHAL firmware, so it links to exactly this source.
function source() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: '..' }).trim();
  try {
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    if (dirty && process.env.CI) throw new Error('refusing to build a release from a modified working tree');
    return { repo: REPO, commit: git('rev-parse', 'HEAD'), dirty, core: git('rev-parse', 'HEAD:src/grbl') };
  } catch (err) {
    if (process.env.CI) throw err;
    return { repo: REPO, commit: null, dirty: false, core: null };
  }
}

export default defineConfig({
  // Relative asset URLs, so the build can be served from any path.
  base: './',
  define: { __SOURCE__: JSON.stringify(source()) },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
