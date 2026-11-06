import { HOUR_MS, MINUTE_MS } from '../../common/time.js';
import { envSchema } from '../config/env.schema.js';
import { RATE_LIMIT_POLICIES } from './rate-limit.policies.js';
import { ipAndEmailTracker } from './trackers.js';

describe('rate-limit policies', () => {
  const defaults = envSchema.shape;

  it.each(Object.entries(RATE_LIMIT_POLICIES))(
    '%s: its limit is a validated, positive integer setting with a default',
    (_name, policy) => {
      const setting = defaults[policy.limit];
      expect(setting).toBeDefined();
      const value = setting.parse(undefined);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    },
  );

  it('keeps the documented defaults', () => {
    const limit = (name: keyof typeof RATE_LIMIT_POLICIES) =>
      defaults[RATE_LIMIT_POLICIES[name].limit].parse(undefined);
    expect(limit('credentials')).toBe(5);
    expect(limit('register')).toBe(10);
    expect(limit('refresh')).toBe(30);
    expect(limit('tokenAction')).toBe(10);
    expect(limit('resend')).toBe(5);
    expect(defaults.RATE_LIMIT_DEFAULT_PER_MINUTE.parse(undefined)).toBe(100);
  });

  it('uses the right window for each policy', () => {
    expect(RATE_LIMIT_POLICIES.credentials.windowMs).toBe(MINUTE_MS);
    expect(RATE_LIMIT_POLICIES.register.windowMs).toBe(HOUR_MS);
    expect(RATE_LIMIT_POLICIES.resend.windowMs).toBe(HOUR_MS);
  });

  it('only the credentials policy keys on IP + email', () => {
    const withTracker = Object.entries(RATE_LIMIT_POLICIES)
      .filter(([, policy]) => 'tracker' in policy)
      .map(([name]) => name);
    expect(withTracker).toEqual(['credentials']);
    expect(RATE_LIMIT_POLICIES.credentials.tracker).toBe(ipAndEmailTracker);
  });

  it('a setting cannot be set to zero or garbage (that would disable the safeguard)', () => {
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
      const setting = defaults[policy.limit];
      expect(() => setting.parse('0')).toThrow();
      expect(() => setting.parse('abc')).toThrow();
      expect(() => setting.parse('-5')).toThrow();
    }
  });
});

describe('ipAndEmailTracker', () => {
  it('combines IP and a normalised email', () => {
    expect(
      ipAndEmailTracker({
        ip: '1.2.3.4',
        body: { email: ' Ada@Example.COM ' },
      }),
    ).toBe('1.2.3.4|ada@example.com');
  });

  it.each([undefined, null, 42, {}, ['a']])(
    'tolerates a non-string email (%j): validation has not run yet',
    (email) => {
      expect(ipAndEmailTracker({ ip: '1.2.3.4', body: { email } })).toBe(
        '1.2.3.4|',
      );
    },
  );

  it('tolerates a missing body, and bounds the key size for a huge email', () => {
    expect(ipAndEmailTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4|');
    const key = ipAndEmailTracker({
      ip: '1.2.3.4',
      body: { email: 'a'.repeat(10_000) },
    });
    expect(key.length).toBeLessThan(300);
  });
});
