import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT, errors, jwtVerify } from 'jose';
import { AppConfigService } from '../../core/config/config.service.js';

const ISSUER = 'saas-xray';
const AUDIENCE = 'saas-xray-api';

export interface AccessClaims {
  /** User id. */
  userId: string;
  /** Session id: the refresh-token family this access token belongs to. */
  sessionId: string;
  isDemo: boolean;
}

/** SHA-256 of a token, hex. Only hashes of refresh/verify/reset tokens are ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(config: AppConfigService) {
    this.key = new TextEncoder().encode(config.get('JWT_ACCESS_SECRET'));
    this.ttlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS');
  }

  get accessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /**
   * Deliberately carries NO role or organisation: roles are looked up per request, so a
   * demotion or removal takes effect immediately instead of when the token expires.
   */
  async signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sessionId, isDemo: claims.isDemo })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  /** Returns the claims, or undefined for anything invalid (bad signature, expired, wrong shape). */
  async verifyAccessToken(token: string): Promise<AccessClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        // Pinning the algorithm closes the classic "alg: none" / key-confusion attacks.
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.isDemo !== 'boolean'
      ) {
        return undefined;
      }
      return {
        userId: payload.sub,
        sessionId: payload.sid,
        isDemo: payload.isDemo,
      };
    } catch (error) {
      if (error instanceof errors.JOSEError) return undefined;
      throw error;
    }
  }

  /** 256 bits of randomness, URL-safe. */
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
