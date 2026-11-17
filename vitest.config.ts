import { defineConfig } from 'vitest/config';

// Unit + style-contract tests for the renderer (Node environment: the pure
// modules and the stylesheet never touch the DOM at import time). The live
// UI paths stay covered by the Electron smoke harness (`npm run smoke:ui`).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['web/src/**/*.test.ts'],
  },
});
