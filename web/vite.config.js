import { defineConfig } from 'vite';

export default defineConfig({
  // The firmware package is linked from ../pkg, which has no node_modules of
  // its own: resolve its three.js peer dependency from this app.
  server: { fs: { allow: ['..'] } },
  resolve: { dedupe: ['three'] },
  // Keep the package out of dependency pre-bundling: its Worker and .wasm
  // files are found through new URL(..., import.meta.url), which must stay
  // relative to the package's own files.
  optimizeDeps: { exclude: ['@parrotmac/grblhal-web'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
