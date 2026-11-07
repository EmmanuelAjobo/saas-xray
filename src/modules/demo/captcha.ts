import { Logger } from '@nestjs/common';

/** Proves a request comes from a person, not a script. */
export interface CaptchaVerifier {
  /** True only if the token is valid. Anything unclear (network error, bad answer) is false. */
  verify(token: string | undefined, ip: string | undefined): Promise<boolean>;
}

export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Used when no secret is configured (local development): everything passes. */
export class NoCaptcha implements CaptchaVerifier {
  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/**
 * Cloudflare Turnstile. Fails CLOSED: if Cloudflare cannot be reached the demo refuses
 * rather than letting unverified traffic create sandboxes.
 */
export class TurnstileCaptcha implements CaptchaVerifier {
  private readonly logger = new Logger(TurnstileCaptcha.name);

  constructor(
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  async verify(
    token: string | undefined,
    ip: string | undefined,
  ): Promise<boolean> {
    if (!token) return false;
    try {
      const body = new URLSearchParams({
        secret: this.secret,
        response: token,
      });
      if (ip) body.set('remoteip', ip);
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { success?: unknown };
      return result.success === true;
    } catch (error) {
      this.logger.error(
        `Captcha verification failed to run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
