import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the shared package straight to source. No build step, no dual
      // ESM/CJS packaging, and edits to the simulation hot-reload instantly.
      '@snow/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // Bind 0.0.0.0 so phones on the same WiFi can reach the dev server.
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
