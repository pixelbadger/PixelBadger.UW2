import { defineConfig } from 'vitest/config';

// Relative base: the built site works from any path (GitHub Pages project sites live under /<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true, outDir: 'dist' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
