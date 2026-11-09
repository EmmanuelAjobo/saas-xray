import { z } from 'zod';
import { ARGON2_LIMITS } from './security-limits.js';

/**
 * Environment contract for the whole app. Validated once at boot: if anything here is
 * missing or malformed the process refuses to start (fail fast) instead of failing later,
 * in the middle of a request.
 *
 * Add a variable here in the same commit that first uses it, and mirror it in `.env.example`.
 */

/**
 * Never throws. Zod keeps running later refinements after an earlier one fails, so every
 * check that parses a URL must tolerate garbage input.
 */
function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** http(s) URL. `z.httpUrl()` is avoided on purpose: it rejects `localhost`. */
const httpUrl = z
  .string()
  .refine((value) => parseHttpUrl(value) !== undefined, {
    message: 'must be a valid http(s) URL',
  });

/** A browser origin: scheme + host (+ port), no path. Trailing slash is tolerated. */
const origin = httpUrl
  .refine(
    (value) => {
      const url = parseHttpUrl(value);
      // Unparseable input is already reported by httpUrl; don't say it twice.
      return url === undefined || url.origin === value.replace(/\/+$/, '');
    },
    {
      message:
        'must be an origin only (e.g. https://app.example.com), without a path',
    },
  )
  .transform((value) => parseHttpUrl(value)?.origin ?? value);

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/** Integer setting with a default and sane bounds, so a typo cannot silently disable a safeguard. */
const intSetting = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** Placeholder that ships in .env.example; accepted in development, refused in production. */
const EXAMPLE_SECRET_PREFIX = 'change-me';

export const MAIL_DRIVERS = ['smtp', 'resend'] as const;

const baseSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** CORS allowlist: the web app origin. Never a wildcard. */
  WEB_ORIGIN: origin,

  /** Number of reverse proxies in front of the API, so client IPs are read correctly. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /** Requests slower than this fail cleanly with 408. */
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10)
    .max(120_000)
    .default(10_000),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /** Base of the `type` URI in RFC 7807 error responses. */
  ERROR_DOCS_BASE_URL: httpUrl
    .default('http://localhost:3000/docs/errors')
    .transform((value) => value.replace(/\/+$/, '')),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/, {
    message: 'must be a postgres:// or postgresql:// URL',
  }),
  REDIS_URL: z.string().regex(/^rediss?:\/\/.+/, {
    message: 'must be a redis:// or rediss:// URL',
  }),

  /** Signs access tokens (HS256). Generate with: openssl rand -base64 48 */
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, { message: 'must be at least 32 characters' }),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),
  /** Sliding window: each refresh extends the session by this much... */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** ...but never beyond this since the original login. */
  REFRESH_TOKEN_MAX_AGE_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),

  /** `smtp` (Mailpit locally) or `resend` (production). */
  MAIL_DRIVER: z.enum(MAIL_DRIVERS).default('smtp'),
  SMTP_URL: z
    .string()
    .regex(/^smtps?:\/\/.+/, { message: 'must be a smtp:// or smtps:// URL' })
    .default('smtp://localhost:1025'),
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default('SaaS X-ray <no-reply@saas-xray.local>'),
  /** Give up on the mail server after this long (connect, greeting, send). */
  MAIL_TIMEOUT_MS: intSetting(10_000, 1_000, 60_000),

  /** How long an email-verification link works. */
  EMAIL_VERIFY_TTL_HOURS: intSetting(24, 1, 168),
  /** How long a password-reset link works. Short on purpose. */
  PASSWORD_RESET_TTL_MINUTES: intSetting(60, 5, 1440),

  /** argon2id cost. Defaults are the OWASP baseline; raise as hardware gets faster. */
  PASSWORD_HASH_MEMORY_KIB: intSetting(
    19_456,
    ARGON2_LIMITS.memoryKiB.min,
    ARGON2_LIMITS.memoryKiB.max,
  ),
  PASSWORD_HASH_PASSES: intSetting(
    2,
    ARGON2_LIMITS.passes.min,
    ARGON2_LIMITS.passes.max,
  ),
  PASSWORD_HASH_PARALLELISM: intSetting(
    1,
    ARGON2_LIMITS.parallelism.min,
    ARGON2_LIMITS.parallelism.max,
  ),

  /** Rate limits. Per client IP unless noted; `credentials` is per IP + email. */
  RATE_LIMIT_DEFAULT_PER_MINUTE: intSetting(100, 1, 100_000),
  /** login and forgot-password, per IP + email. */
  RATE_LIMIT_CREDENTIALS_PER_MINUTE: intSetting(5, 1, 1_000),
  RATE_LIMIT_REGISTER_PER_HOUR: intSetting(10, 1, 10_000),
  RATE_LIMIT_REFRESH_PER_MINUTE: intSetting(30, 1, 10_000),
  /** verify-email and reset-password. */
  RATE_LIMIT_TOKEN_ACTIONS_PER_MINUTE: intSetting(10, 1, 1_000),
  RATE_LIMIT_RESEND_PER_HOUR: intSetting(5, 1, 1_000),

  /** Wait this long for Postgres to accept a connection (boot and every new connection). */
  DATABASE_CONNECTION_TIMEOUT_MS: intSetting(5_000, 100, 60_000),
  /** Most database connections the API holds open. Raise for heavy traffic (mind Postgres's own limit). */
  DATABASE_POOL_MAX: intSetting(10, 1, 200),
  /** A Redis command is retried this many times before it fails the request. */
  REDIS_MAX_RETRIES_PER_REQUEST: intSetting(2, 0, 10),
  /** A dependency slower than this counts as down in /health/ready. */
  HEALTH_CHECK_TIMEOUT_MS: intSetting(2_000, 100, 30_000),
  /** How long browsers may cache the CORS preflight answer. */
  CORS_MAX_AGE_SECONDS: intSetting(600, 0, 86_400),

  /** Most organisations one user may own (stops runaway creation by a script or a bug). */
  MAX_ORGS_PER_USER: intSetting(5, 1, 1_000),
  RATE_LIMIT_ORG_CREATE_PER_HOUR: intSetting(10, 1, 10_000),

  /** How long an invitation link works. */
  INVITATION_TTL_DAYS: intSetting(7, 1, 30),
  /** Sending and re-sending invitations, per client IP. */
  RATE_LIMIT_INVITE_PER_HOUR: intSetting(30, 1, 10_000),

  /** Seats (members + pending invitations) allowed per plan. */
  FREE_PLAN_MAX_SEATS: intSetting(3, 1, 100_000),
  PRO_PLAN_MAX_SEATS: intSetting(25, 1, 100_000),

  /** List endpoints: page size when `limit` is omitted, and the most one page may return. */
  PAGE_SIZE_DEFAULT: intSetting(20, 1, 1_000),
  PAGE_SIZE_MAX: intSetting(100, 1, 1_000),

  /** Invoices: currency when none is given (ISO 4217), payment terms, and size cap. */
  INVOICE_DEFAULT_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/, {
      message: 'must be a 3-letter ISO 4217 code, e.g. USD',
    })
    .default('USD'),
  /** A sent invoice with no due date is due this many days later. */
  INVOICE_DEFAULT_TERMS_DAYS: intSetting(14, 1, 365),
  INVOICE_MAX_LINE_ITEMS: intSetting(100, 1, 1_000),

  /** The public "Try the demo" button. Set to false to switch it off (404). */
  DEMO_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Live sandboxes allowed at once; beyond this the button answers 503 until some expire. */
  DEMO_MAX_ACTIVE: intSetting(200, 1, 100_000),
  RATE_LIMIT_DEMO_PER_HOUR: intSetting(10, 1, 10_000),
  /** How often expired sandboxes are deleted, in minutes. 0 turns the timer off. */
  DEMO_PURGE_INTERVAL_MINUTES: intSetting(15, 0, 1_440),
  /** Sandboxes deleted per purge run (the rest wait for the next run). */
  DEMO_PURGE_BATCH_SIZE: intSetting(50, 1, 1_000),
  /**
   * Cloudflare Turnstile secret. When set, the demo button requires a valid challenge token
   * (bot protection). Leave unset in development.
   */
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  /** Give up on the captcha provider after this long (the demo then refuses, never allows). */
  CAPTCHA_TIMEOUT_MS: intSetting(5_000, 500, 30_000),

  /** How long a "Try the demo" sandbox lives before it is deleted. */
  DEMO_TTL_HOURS: intSetting(24, 1, 168),

  /**
   * Background jobs (invoice emails, the overdue sweep). The worker runs inside this process
   * unless WORKER_ENABLED=false (then only enqueueing happens here and another process runs
   * the worker).
   */
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** The Redis queue's name. Change it only to keep two deployments apart on one Redis. */
  JOBS_QUEUE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, {
      message: 'must be 1-64 letters, digits, "_" or "-"',
    })
    .default('saas-xray-jobs'),
  /** Jobs one worker runs at the same time. */
  JOB_WORKER_CONCURRENCY: intSetting(5, 1, 100),
  /** An invoice email is tried this many times in total before it is given up on. */
  EMAIL_JOB_ATTEMPTS: intSetting(3, 1, 10),
  /** Wait before the first retry; it doubles after each failure. */
  JOB_BACKOFF_MS: intSetting(5_000, 100, 3_600_000),
  /** How long finished jobs are kept for inspection, and the most that are kept. */
  JOB_KEEP_COMPLETED_SECONDS: intSetting(3_600, 60, 604_800),
  JOB_KEEP_COMPLETED_COUNT: intSetting(1_000, 10, 100_000),
  /** Failed jobs are kept this long (this is the dead-letter set). */
  JOB_KEEP_FAILED_SECONDS: intSetting(604_800, 3_600, 2_592_000),
  /** How often overdue invoices are marked, in minutes. 0 turns the sweep off. */
  OVERDUE_SWEEP_INTERVAL_MINUTES: intSetting(60, 0, 1_440),
  /** Organisations handled per sweep run (the rest wait for the next run). */
  OVERDUE_SWEEP_ORG_BATCH: intSetting(100, 1, 10_000),

  /** Emails kept per demo sandbox in its Outbox (what the sandbox "sent" but never delivered). */
  OUTBOX_MAX_MESSAGES: intSetting(20, 1, 200),

  /** The Backend X-ray (a live record of what the backend does per request). false = off. */
  XRAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Most events kept per organisation; older ones are dropped. */
  XRAY_BUFFER_SIZE: intSetting(200, 10, 2_000),
  /** An organisation's events expire this long after its last activity. */
  XRAY_BUFFER_TTL_SECONDS: intSetting(3_600, 60, 86_400),
  /** Events returned when a client asks for history without saying how many. */
  XRAY_REPLAY_DEFAULT: intSetting(50, 1, 2_000),
  /** A live stream sends a keep-alive this often so proxies do not close it as idle. */
  XRAY_HEARTBEAT_SECONDS: intSetting(15, 1, 60),
  /**
   * A live stream is closed after this long and the client reconnects. Permission and
   * membership are checked at connect time, so this bounds how long a removed member could
   * keep watching.
   */
  XRAY_STREAM_MAX_SECONDS: intSetting(600, 30, 3_600),
  /** Live streams one user may hold open at once (each one holds a connection). */
  XRAY_MAX_STREAMS_PER_USER: intSetting(3, 1, 20),
});

export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.MAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_API_KEY'],
      message: 'is required when MAIL_DRIVER=resend',
    });
  }
  if (
    env.NODE_ENV === 'production' &&
    env.JWT_ACCESS_SECRET.startsWith(EXAMPLE_SECRET_PREFIX)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_ACCESS_SECRET'],
      message: 'is still the example value; generate a real secret',
    });
  }
  if (env.PAGE_SIZE_DEFAULT > env.PAGE_SIZE_MAX) {
    ctx.addIssue({
      code: 'custom',
      path: ['PAGE_SIZE_DEFAULT'],
      message: 'must not be larger than PAGE_SIZE_MAX',
    });
  }
  if (env.XRAY_REPLAY_DEFAULT > env.XRAY_BUFFER_SIZE) {
    ctx.addIssue({
      code: 'custom',
      path: ['XRAY_REPLAY_DEFAULT'],
      message: 'must not be larger than XRAY_BUFFER_SIZE',
    });
  }
  if (env.PRO_PLAN_MAX_SEATS < env.FREE_PLAN_MAX_SEATS) {
    ctx.addIssue({
      code: 'custom',
      path: ['PRO_PLAN_MAX_SEATS'],
      message: 'must not be lower than FREE_PLAN_MAX_SEATS',
    });
  }
  if (env.REFRESH_TOKEN_MAX_AGE_DAYS < env.REFRESH_TOKEN_TTL_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['REFRESH_TOKEN_MAX_AGE_DAYS'],
      message: 'must not be shorter than REFRESH_TOKEN_TTL_DAYS',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses and validates raw environment variables. Empty strings count as "not set", so a
 * `FOO=` line in a .env file falls back to the default (or fails if required).
 * Error messages name the variable and the problem, never its value (it may be a secret).
 */
export function validateEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
