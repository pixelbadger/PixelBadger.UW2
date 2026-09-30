import { defineConfig } from 'vitest/config';

// Integration tests against the user's own disc (never committed): UW2_DATA = a disc image (.iso/.bin) or a folder
// holding UW2/ (or UW2/ itself). Without it the tests skip, unless UW2_DATA_REQUIRED=1 (the deploy gate), when they fail.
export default defineConfig({
  test: {
    include: ['tests/data/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
