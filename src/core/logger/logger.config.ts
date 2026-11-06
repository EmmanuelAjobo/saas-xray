import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { getRequestIdFromRequest } from '../context/request-id.js';

/**
 * Anything that could carry a credential is censored before it reaches a log line.
 * Pino path syntax: `*.x` matches `x` one level down. Extend this list whenever a new
 * secret-bearing field is introduced (API keys, refresh tokens, webhook secrets...).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
];

export const REDACT_CENSOR = '[REDACTED]';

interface LoggerSettings {
  level: string;
  /** Pretty, human-readable output (development only). JSON everywhere else. */
  pretty: boolean;
}

export function buildPinoHttpOptions({
  level,
  pretty,
}: LoggerSettings): Options {
  return {
    level,
    // The id was already decided by requestIdMiddleware; just read it.
    genReqId: (req: IncomingMessage) =>
      getRequestIdFromRequest(
        req as unknown as { headers: Record<string, unknown> },
      ),
    customProps: (req: IncomingMessage) => ({
      requestId: (req as IncomingMessage & { id?: unknown }).id,
    }),
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    // Probes hit these every few seconds; logging them drowns real traffic.
    autoLogging: {
      ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false,
    },
    customLogLevel: (
      _req: IncomingMessage,
      res: ServerResponse,
      err?: Error,
    ) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { singleLine: true, colorize: true },
          },
        }
      : {}),
  };
}
