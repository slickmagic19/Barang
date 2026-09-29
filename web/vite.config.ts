import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 5000 }).trim() || 'dev';
  } catch {
    return 'dev';
  }
}

// Monaco is lazy-loaded (own chunk) so first paint stays instant.
// NOTE (desktop): the renderer runs inside Electron and talks to main over
// IPC (see src/lib/transport.ts). No dev proxy is needed; Vite only serves
// the UI, and Electron loads it via BARANG_VITE in `npm run dev`.
export default defineConfig({
  // Relative asset URLs: the renderer loads over file:// inside Electron.
  base: './',
  // Build identity stamp (About dialog + staleness checks).
  define: {
    __BARANG_COMMIT__: JSON.stringify(process.env.BARANG_COMMIT || gitCommit()),
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500, // monaco chunk is intentionally large + lazy
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
