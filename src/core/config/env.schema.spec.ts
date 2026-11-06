import { EnvValidationError, validateEnv } from './env.schema.js';

const valid = {
  WEB_ORIGIN: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://user:secret-pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'unit-test-secret-that-is-at-least-32-chars',
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      TRUST_PROXY_HOPS: 0,
      REQUEST_TIMEOUT_MS: 10_000,
      LOG_LEVEL: 'info',
      ERROR_DOCS_BASE_URL: 'http://localhost:3000/docs/errors',
    });
  });

  it('coerces numeric strings (process.env values are always strings)', () => {
    const env = validateEnv({
      ...valid,
      PORT: '8080',
      TRUST_PROXY_HOPS: '1',
      REQUEST_TIMEOUT_MS: '5000',
    });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY_HOPS).toBe(1);
    expect(env.REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'WEB_ORIGIN', 'JWT_ACCESS_SECRET'])(
    'requires %s',
    (key) => {
      const { [key]: _removed, ...rest } = valid as Record<string, string>;
      expect(() => validateEnv(rest)).toThrow(EnvValidationError);
      expect(() => validateEnv(rest)).toThrow(key);
    },
  );

  it('treats empty strings as unset (a bare `FOO=` line in .env)', () => {
    expect(validateEnv({ ...valid, PORT: '' }).PORT).toBe(3000);
    expect(() => validateEnv({ ...valid, DATABASE_URL: '' })).toThrow(
      'DATABASE_URL',
    );
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['REQUEST_TIMEOUT_MS', '1'],
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['WEB_ORIGIN', 'not a url'],
    ['WEB_ORIGIN', 'ftp://example.com'],
    ['WEB_ORIGIN', 'https://app.example.com/some/path'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(
      EnvValidationError,
    );
  });

  it('normalises WEB_ORIGIN (strips a trailing slash) so CORS matching is exact', () => {
    expect(
      validateEnv({ ...valid, WEB_ORIGIN: 'https://app.example.com/' })
        .WEB_ORIGIN,
    ).toBe('https://app.example.com');
  });

  describe('auth and mail settings', () => {
    it('applies safe defaults', () => {
      expect(validateEnv(valid)).toMatchObject({
        ACCESS_TOKEN_TTL_SECONDS: 900,
        REFRESH_TOKEN_TTL_DAYS: 7,
        REFRESH_TOKEN_MAX_AGE_DAYS: 30,
        MAIL_DRIVER: 'smtp',
        SMTP_URL: 'smtp://localhost:1025',
      });
    });

    it('rejects a JWT secret shorter than 32 characters, without echoing it', () => {
      const attempt = () =>
        validateEnv({ ...valid, JWT_ACCESS_SECRET: 'too-short-secret' });
      expect(attempt).toThrow('JWT_ACCESS_SECRET');
      expect(attempt).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('too-short-secret'),
        }),
      );
    });

    it('refuses the example secret in production, but allows it in development', () => {
      const example = 'change-me-dev-only-secret-at-least-32-characters-long';
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: example,
        }),
      ).toThrow('example value');
      expect(
        validateEnv({ ...valid, JWT_ACCESS_SECRET: example }).JWT_ACCESS_SECRET,
      ).toBe(example);
    });

    it('requires an API key when the mail driver is resend', () => {
      expect(() => validateEnv({ ...valid, MAIL_DRIVER: 'resend' })).toThrow(
        'RESEND_API_KEY',
      );
      expect(
        validateEnv({
          ...valid,
          MAIL_DRIVER: 'resend',
          RESEND_API_KEY: 're_123',
        }).MAIL_DRIVER,
      ).toBe('resend');
    });

    it('rejects a session cap shorter than the sliding window', () => {
      expect(() =>
        validateEnv({
          ...valid,
          REFRESH_TOKEN_TTL_DAYS: '10',
          REFRESH_TOKEN_MAX_AGE_DAYS: '5',
        }),
      ).toThrow('REFRESH_TOKEN_MAX_AGE_DAYS');
    });

    it.each([
      ['ACCESS_TOKEN_TTL_SECONDS', '5'],
      ['ACCESS_TOKEN_TTL_SECONDS', '999999'],
      ['MAIL_DRIVER', 'sendgrid'],
      ['SMTP_URL', 'http://localhost:1025'],
    ])('rejects %s=%s', (key, value) => {
      expect(() => validateEnv({ ...valid, [key]: value })).toThrow(
        EnvValidationError,
      );
    });
  });

  it('reports every problem at once, not just the first', () => {
    try {
      validateEnv({ PORT: 'abc' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('PORT');
      expect(message).toContain('WEB_ORIGIN');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
    }
  });

  it('never echoes a secret value in the error message', () => {
    expect(() =>
      validateEnv({
        ...valid,
        DATABASE_URL: 'mysql://user:secret-pass@host/db',
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secret-pass'),
      }),
    );
  });
});
