import { defineConfig } from 'vitest/config';

/**
 * Integration tests: real Postgres (the `saas_xray_test` database from docker-compose),
 * no mocks. Requires `docker compose up -d --wait`.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    globalSetup: ['./test/support/integration-global-setup.ts'],
    setupFiles: ['./test/support/integration-env.ts'],
    // One shared database, so files must not run at the same time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
