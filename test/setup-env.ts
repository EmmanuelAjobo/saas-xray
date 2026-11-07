/**
 * Deterministic environment for every test file, independent of the developer's .env.
 * `??=` lets CI override a value (for example pointing DATABASE_URL at a service container).
 * Tests never read `.env`: loading it is main.ts's job, not the app module's.
 */
process.env.NODE_ENV = 'test';
process.env.PORT ??= '3000';
process.env.WEB_ORIGIN ??= 'http://localhost:3001';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5433/saas_xray_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// Tests start the purge themselves; no background timers.
process.env.DEMO_PURGE_INTERVAL_MINUTES ??= '0';
process.env.JWT_ACCESS_SECRET ??= 'test-only-secret-that-is-at-least-32-chars';
