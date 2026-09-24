import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The firmware is built by CMake into ../build (see the top-level README).
const firmware = fileURLToPath(new URL('../build', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@firmware': firmware } },
  server: { fs: { allow: ['..'] } },
  optimizeDeps: { exclude: ['@firmware'] },
  build: { target: 'es2022' },
});
