import { HOUR_MS, MINUTE_MS } from '../../common/time.js';
import type { Env } from '../config/env.schema.js';
import { ipAndEmailTracker } from './trackers.js';

/**
 * Named rate-limit policies. A route says WHICH policy applies (`@RateLimit('credentials')`);
 * the numbers come from the environment, so they can be tuned per deployment without a
 * code change. (Decorator arguments are evaluated before the config exists, which is why the
 * route cannot carry a number itself.)
 */
export const RATE_LIMIT_POLICIES = {
  /** login, forgot-password: guessing protection, per IP + email. */
  credentials: {
    limit: 'RATE_LIMIT_CREDENTIALS_PER_MINUTE',
    windowMs: MINUTE_MS,
    tracker: ipAndEmailTracker,
  },
  register: {
    limit: 'RATE_LIMIT_REGISTER_PER_HOUR',
    windowMs: HOUR_MS,
  },
  refresh: {
    limit: 'RATE_LIMIT_REFRESH_PER_MINUTE',
    windowMs: MINUTE_MS,
  },
  /** verify-email, reset-password. */
  tokenAction: {
    limit: 'RATE_LIMIT_TOKEN_ACTIONS_PER_MINUTE',
    windowMs: MINUTE_MS,
  },
  resend: {
    limit: 'RATE_LIMIT_RESEND_PER_HOUR',
    windowMs: HOUR_MS,
  },
  demo: {
    limit: 'RATE_LIMIT_DEMO_PER_HOUR',
    windowMs: HOUR_MS,
  },
  invite: {
    limit: 'RATE_LIMIT_INVITE_PER_HOUR',
    windowMs: HOUR_MS,
  },
  orgCreate: {
    limit: 'RATE_LIMIT_ORG_CREATE_PER_HOUR',
    windowMs: HOUR_MS,
  },
} as const satisfies Record<
  string,
  {
    limit: {
      [K in keyof Env]: Env[K] extends number ? K : never;
    }[keyof Env];
    windowMs: number;
    tracker?: (req: Record<string, unknown>) => string;
  }
>;

export type RateLimitPolicy = keyof typeof RATE_LIMIT_POLICIES;
