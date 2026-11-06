import { AppConfigService } from '../../src/core/config/config.service.js';
import { validateEnv } from '../../src/core/config/env.schema.js';

/**
 * A real AppConfigService built through the real env validation, with only the required
 * variables filled in. Tests pass overrides for what they care about, and every other setting
 * gets its production default (so a test cannot drift from the real config shape).
 */
export function testConfig(
  overrides: Record<string, string> = {},
): AppConfigService {
  return new AppConfigService(
    validateEnv({
      WEB_ORIGIN: 'http://localhost:3001',
      DATABASE_URL:
        'postgresql://postgres:postgres@localhost:5433/saas_xray_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'unit-test-secret-that-is-at-least-32-chars',
      ...overrides,
    }),
  );
}
