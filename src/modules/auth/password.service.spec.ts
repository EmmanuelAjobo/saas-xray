import { testConfig } from '../../../test/support/test-config.js';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService(testConfig());

  it('uses the cost from configuration, and hashes made with another cost still verify', async () => {
    const cheap = new PasswordService(
      testConfig({
        PASSWORD_HASH_MEMORY_KIB: '8192',
        PASSWORD_HASH_PASSES: '1',
        PASSWORD_HASH_PARALLELISM: '2',
      }),
    );
    const hash = await cheap.hash('rotating the cost later');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=2\$/);
    // The parameters travel inside the hash, so raising the cost never locks anyone out.
    expect(await service.verify('rotating the cost later', hash)).toBe(true);
    expect(await service.verify('wrong', hash)).toBe(false);
  });

  it('hashes to a standard argon2id PHC string with the OWASP parameters', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
    expect(hash).not.toContain('correct horse');
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await service.hash('correct horse battery');
    expect(await service.verify('correct horse battery', hash)).toBe(true);
    expect(await service.verify('correct horse batterz', hash)).toBe(false);
    expect(await service.verify('', hash)).toBe(false);
  });

  it('salts every hash: the same password never hashes the same way twice', async () => {
    const [a, b] = await Promise.all([
      service.hash('same password'),
      service.hash('same password'),
    ]);
    expect(a).not.toBe(b);
    expect(await service.verify('same password', a)).toBe(true);
    expect(await service.verify('same password', b)).toBe(true);
  });

  it('handles unicode and very long passwords', async () => {
    const unicode = 'pässwörd-密码-🔐-long-enough';
    expect(await service.verify(unicode, await service.hash(unicode))).toBe(
      true,
    );
    const long = 'x'.repeat(128);
    expect(await service.verify(long, await service.hash(long))).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['plain text', 'not-a-hash'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuK1bT0kfVYiG4n8cZ1E6k3pWQ7bC0Ya'],
    ['wrong variant', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ=$aGFzaA=='],
    ['truncated', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA'],
  ])(
    'treats a malformed stored hash (%s) as a mismatch, never a crash',
    async (_label, stored) => {
      expect(await service.verify('anything', stored)).toBe(false);
    },
  );

  it.each([
    [
      'huge memory',
      '$argon2id$v=19$m=99999999,t=2,p=1$c2FsdHNhbHRzYWx0cw==$aGFzaGhhc2g=',
    ],
    [
      'huge passes',
      '$argon2id$v=19$m=19456,t=99999,p=1$c2FsdHNhbHRzYWx0cw==$aGFzaGhhc2g=',
    ],
    [
      'zero parallelism',
      '$argon2id$v=19$m=19456,t=2,p=0$c2FsdHNhbHRzYWx0cw==$aGFzaGhhc2g=',
    ],
  ])(
    'refuses hostile cost parameters (%s) instead of allocating them',
    async (_label, stored) => {
      const started = Date.now();
      expect(await service.verify('anything', stored)).toBe(false);
      expect(Date.now() - started).toBeLessThan(500);
    },
  );

  it('verifyAgainstDummy spends comparable time to a real verify and always returns false', async () => {
    const hash = await service.hash('warm up');
    await service.verifyAgainstDummy('warm up'); // initialise the dummy once

    const time = async (fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };
    // Best of several runs each: one slow sample (CPU contention from parallel test files)
    // must not decide the outcome.
    const best = async (fn: () => Promise<unknown>) =>
      Math.min(await time(fn), await time(fn), await time(fn));
    const real = await best(() => service.verify('x', hash));
    const dummy = await best(() => service.verifyAgainstDummy('x'));

    expect(await service.verifyAgainstDummy('x')).toBe(false);
    // Same order of magnitude (generous bounds: this guards against "returns instantly").
    expect(dummy).toBeGreaterThan(real * 0.3);
  });
});
