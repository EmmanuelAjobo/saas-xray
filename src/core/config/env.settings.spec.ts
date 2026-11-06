import { ARGON2_LIMITS } from './security-limits.js';
import { EnvValidationError, validateEnv } from './env.schema.js';

const valid = {
  WEB_ORIGIN: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'unit-test-secret-that-is-at-least-32-chars',
};

describe('tunable settings', () => {
  it('every one has a default, so a minimal .env still boots', () => {
    expect(validateEnv(valid)).toMatchObject({
      MAIL_TIMEOUT_MS: 10_000,
      EMAIL_VERIFY_TTL_HOURS: 24,
      PASSWORD_RESET_TTL_MINUTES: 60,
      PASSWORD_HASH_MEMORY_KIB: 19_456,
      PASSWORD_HASH_PASSES: 2,
      PASSWORD_HASH_PARALLELISM: 1,
      RATE_LIMIT_DEFAULT_PER_MINUTE: 100,
      RATE_LIMIT_CREDENTIALS_PER_MINUTE: 5,
      RATE_LIMIT_REGISTER_PER_HOUR: 10,
      RATE_LIMIT_REFRESH_PER_MINUTE: 30,
      RATE_LIMIT_TOKEN_ACTIONS_PER_MINUTE: 10,
      RATE_LIMIT_RESEND_PER_HOUR: 5,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      DATABASE_POOL_MAX: 10,
      PAGE_SIZE_DEFAULT: 20,
      PAGE_SIZE_MAX: 100,
      INVOICE_DEFAULT_CURRENCY: 'USD',
      INVOICE_DEFAULT_TERMS_DAYS: 14,
      INVOICE_MAX_LINE_ITEMS: 100,
      REDIS_MAX_RETRIES_PER_REQUEST: 2,
      HEALTH_CHECK_TIMEOUT_MS: 2_000,
      CORS_MAX_AGE_SECONDS: 600,
      DEMO_TTL_HOURS: 24,
      MAX_ORGS_PER_USER: 5,
      RATE_LIMIT_ORG_CREATE_PER_HOUR: 10,
      INVITATION_TTL_DAYS: 7,
      RATE_LIMIT_INVITE_PER_HOUR: 30,
      FREE_PLAN_MAX_SEATS: 3,
      PRO_PLAN_MAX_SEATS: 25,
    });
  });

  it('accepts overrides, coercing the strings that process.env always holds', () => {
    const env = validateEnv({
      ...valid,
      RATE_LIMIT_CREDENTIALS_PER_MINUTE: '3',
      EMAIL_VERIFY_TTL_HOURS: '48',
      DEMO_TTL_HOURS: '6',
    });
    expect(env.RATE_LIMIT_CREDENTIALS_PER_MINUTE).toBe(3);
    expect(env.EMAIL_VERIFY_TTL_HOURS).toBe(48);
    expect(env.DEMO_TTL_HOURS).toBe(6);
  });

  it.each([
    // A zero or negative limit would silently disable (or break) a safeguard.
    ['RATE_LIMIT_CREDENTIALS_PER_MINUTE', '0'],
    ['RATE_LIMIT_DEFAULT_PER_MINUTE', '-1'],
    ['RATE_LIMIT_REGISTER_PER_HOUR', 'many'],
    ['RATE_LIMIT_REFRESH_PER_MINUTE', '1.5'],
    ['EMAIL_VERIFY_TTL_HOURS', '0'],
    ['PASSWORD_RESET_TTL_MINUTES', '1'],
    ['PASSWORD_RESET_TTL_MINUTES', '99999'],
    ['MAIL_TIMEOUT_MS', '1'],
    ['DATABASE_CONNECTION_TIMEOUT_MS', '10'],
    ['HEALTH_CHECK_TIMEOUT_MS', '999999'],
    ['REDIS_MAX_RETRIES_PER_REQUEST', '-1'],
    ['DEMO_TTL_HOURS', '0'],
    ['MAX_ORGS_PER_USER', '0'],
    ['PAGE_SIZE_MAX', '0'],
    ['PAGE_SIZE_DEFAULT', '-1'],
    ['INVOICE_DEFAULT_CURRENCY', 'usd'],
    ['INVOICE_DEFAULT_CURRENCY', 'US'],
    ['INVOICE_DEFAULT_CURRENCY', 'DOLLARS'],
    ['INVOICE_DEFAULT_TERMS_DAYS', '0'],
    ['INVOICE_MAX_LINE_ITEMS', '0'],
    ['DATABASE_POOL_MAX', '0'],
    ['INVITATION_TTL_DAYS', '0'],
    ['INVITATION_TTL_DAYS', '365'],
    ['FREE_PLAN_MAX_SEATS', '0'],
    ['RATE_LIMIT_INVITE_PER_HOUR', '-1'],
    // Password hashing: refuse a cost too weak to protect, or so big it exhausts memory.
    ['PASSWORD_HASH_MEMORY_KIB', String(ARGON2_LIMITS.memoryKiB.min - 1)],
    ['PASSWORD_HASH_MEMORY_KIB', String(ARGON2_LIMITS.memoryKiB.max + 1)],
    ['PASSWORD_HASH_PASSES', '0'],
    ['PASSWORD_HASH_PASSES', String(ARGON2_LIMITS.passes.max + 1)],
    ['PASSWORD_HASH_PARALLELISM', '0'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(
      EnvValidationError,
    );
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(key);
  });

  it('refuses a PRO seat limit below the FREE one (an upgrade must never shrink the team)', () => {
    expect(() =>
      validateEnv({
        ...valid,
        FREE_PLAN_MAX_SEATS: '10',
        PRO_PLAN_MAX_SEATS: '5',
      }),
    ).toThrow('PRO_PLAN_MAX_SEATS');
    expect(
      validateEnv({
        ...valid,
        FREE_PLAN_MAX_SEATS: '10',
        PRO_PLAN_MAX_SEATS: '10',
      }).PRO_PLAN_MAX_SEATS,
    ).toBe(10);
  });

  it('refuses a default page size larger than the maximum', () => {
    expect(() =>
      validateEnv({ ...valid, PAGE_SIZE_DEFAULT: '50', PAGE_SIZE_MAX: '20' }),
    ).toThrow('PAGE_SIZE_DEFAULT');
    expect(
      validateEnv({ ...valid, PAGE_SIZE_DEFAULT: '20', PAGE_SIZE_MAX: '20' })
        .PAGE_SIZE_MAX,
    ).toBe(20);
  });

  it('treats an empty value as "use the default" (a bare `KEY=` line)', () => {
    expect(
      validateEnv({ ...valid, RATE_LIMIT_CREDENTIALS_PER_MINUTE: '' })
        .RATE_LIMIT_CREDENTIALS_PER_MINUTE,
    ).toBe(5);
  });
});
