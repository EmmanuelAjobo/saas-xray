import { Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { AppConfigService } from '../../core/config/config.service.js';
import type { Session } from './auth.service.js';

export const REFRESH_COOKIE = 'refresh_token';
/** The cookie is only ever sent to the auth endpoints, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/v1/auth';

/** What a client receives when a session starts: the refresh token is NOT in the body. */
export interface SessionBody {
  accessToken: string;
  expiresIn: number;
  user: Session['user'];
}

/**
 * The one place that knows how the refresh token travels: an HttpOnly cookie scoped to
 * /v1/auth. Shared by every endpoint that starts or ends a session (login, register, demo).
 */
@Injectable()
export class SessionCookies {
  constructor(private readonly config: AppConfigService) {}

  private options(): CookieOptions {
    return {
      httpOnly: true, // not readable by JavaScript: an XSS bug cannot steal it
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
    };
  }

  /** Sets the refresh cookie and returns the body to send. */
  start(res: Response, session: Session): SessionBody {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.options(),
      expires: session.refreshExpiresAt,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  clear(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.options());
  }
}
