import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Booting the whole Nest app (incl. Swagger) per file is slower than a unit test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
