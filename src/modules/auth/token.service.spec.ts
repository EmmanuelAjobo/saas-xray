import { SignJWT } from 'jose';
import type { AppConfigService } from '../../core/config/config.service.js';
import { TokenService, hashToken } from './token.service.js';

const SECRET = 'unit-test-secret-that-is-at-least-32-chars';
const config = (overrides: Record<string, unknown> = {}) =>
  ({
    get: (key: string) =>
      ({
        JWT_ACCESS_SECRET: SECRET,
        ACCESS_TOKEN_TTL_SECONDS: 900,
        ...overrides,
      })[key],
  }) as unknown as AppConfigService;

const claims = { userId: 'user-1', sessionId: 'family-1', isDemo: false };
const encode = (secret: string) => new TextEncoder().encode(secret);

describe('TokenService', () => {
  const service = new TokenService(config());

  it('round-trips the claims', async () => {
    const token = await service.signAccessToken({ ...claims, isDemo: true });
    expect(await service.verifyAccessToken(token)).toEqual({
      ...claims,
      isDemo: true,
    });
  });

  it('puts no role or organisation in the token (permissions are looked up per request)', async () => {
    const token = await service.signAccessToken(claims);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'isDemo', 'sid', 'sub'].sort(),
    );
  });

  it('expires after the configured lifetime', async () => {
    const token = await service.signAccessToken(claims);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString(),
    ) as { exp: number; iat: number };
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('rejects a token signed with another secret', async () => {
    const other = new TokenService(
      config({ JWT_ACCESS_SECRET: 'a-completely-different-secret-32-chars!' }),
    );
    expect(
      await service.verifyAccessToken(await other.signAccessToken(claims)),
    ).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await new SignJWT({ sid: 's', isDemo: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('saas-xray')
      .setAudience('saas-xray-api')
      .setIssuedAt(past - 900)
      .setExpirationTime(past)
      .sign(encode(SECRET));
    expect(await service.verifyAccessToken(token)).toBeUndefined();
  });

  it.each([
    ['issuer', { iss: 'someone-else', aud: 'saas-xray-api' }],
    ['audience', { iss: 'saas-xray', aud: 'another-api' }],
  ])(
    'rejects a validly-signed token with the wrong %s',
    async (_n, { iss, aud }) => {
      const token = await new SignJWT({ sid: 's', isDemo: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u')
        .setIssuer(iss)
        .setAudience(aud)
        .setExpirationTime('5m')
        .sign(encode(SECRET));
      expect(await service.verifyAccessToken(token)).toBeUndefined();
    },
  );

  it('rejects a token signed with a different algorithm family (HS512)', async () => {
    const token = await new SignJWT({ sid: 's', isDemo: false })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u')
      .setIssuer('saas-xray')
      .setAudience('saas-xray-api')
      .setExpirationTime('5m')
      .sign(encode(SECRET));
    expect(await service.verifyAccessToken(token)).toBeUndefined();
  });

  it('rejects a validly-signed token missing the expected claims', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('saas-xray')
      .setAudience('saas-xray-api')
      .setExpirationTime('5m')
      .sign(encode(SECRET));
    expect(await service.verifyAccessToken(token)).toBeUndefined();
  });

  it.each(['', 'garbage', 'a.b.c', 'eyJhbGciOiJub25lIn0.e30.'])(
    'rejects malformed input %j without throwing',
    async (input) => {
      expect(await service.verifyAccessToken(input)).toBeUndefined();
    },
  );

  it('generates unique 256-bit URL-safe opaque tokens', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => service.generateOpaqueToken()),
    );
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, no padding
    }
  });

  it('hashToken is a stable SHA-256 hex digest', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});
