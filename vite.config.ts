import { configDefaults, defineConfig } from 'vitest/config';

// Relative base: the built site works from any path (GitHub Pages project sites live under /<repo>/).
// `npm test` runs everything but tests/data, which needs the real disc (UW2_DATA): `npm run test:data`.
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true, outDir: 'dist' },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/data/**'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
