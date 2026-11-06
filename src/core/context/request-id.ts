import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accepts ids from upstream proxies/clients only if they are short and boring (no log injection). */
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Establishes the request id before anything else runs, so the logger, the request context
 * (CLS), error responses and the response header all agree on one value.
 * Reuses a well-formed incoming `X-Request-Id`; otherwise generates a UUID.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
  req.headers[REQUEST_ID_HEADER] = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Reads the id set by {@link requestIdMiddleware}; falls back to a fresh UUID (e.g. in isolated tests). */
export function getRequestIdFromRequest(req: {
  headers: Record<string, unknown>;
}): string {
  const id = req.headers[REQUEST_ID_HEADER];
  return typeof id === 'string' && id.length > 0 ? id : randomUUID();
}
