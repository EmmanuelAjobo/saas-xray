import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ConflictError,
  DomainError,
  EmailNotVerifiedError,
  PlanLimitExceededError,
  ForbiddenError,
  InvalidStateTransitionError,
  InvalidTokenError,
  LimitReachedError,
  NotFoundError,
  UnauthenticatedError,
} from '../errors/domain-errors.js';
import {
  RequestValidationException,
  type FieldError,
} from '../errors/request-validation.exception.js';

/** RFC 7807 problem document, plus the stable `code` and the `requestId` for support/log lookup. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId?: string;
  /** Per-field validation failures (400 only). */
  errors?: FieldError[];
  /** Readiness probe breakdown (503 from /health/ready only). */
  checks?: unknown;
  /** Where to upgrade (402 plan-limit errors only). */
  upgradeUrl?: string;
}

interface ProblemContext {
  requestId?: string;
  /** Base URL for the `type` URI, no trailing slash. */
  docsBaseUrl: string;
}

const GENERIC_SERVER_ERROR = {
  code: 'INTERNAL_ERROR',
  title: 'Internal server error',
};

/** Code + title for HTTP statuses that reach us as plain HttpExceptions (guards, pipes, Nest itself). */
const STATUS_INFO: Record<number, { code: string; title: string }> = {
  400: { code: 'BAD_REQUEST', title: 'Bad request' },
  401: { code: 'UNAUTHORIZED', title: 'Unauthorized' },
  402: { code: 'PAYMENT_REQUIRED', title: 'Payment required' },
  403: { code: 'FORBIDDEN', title: 'Forbidden' },
  404: { code: 'NOT_FOUND', title: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', title: 'Method not allowed' },
  406: { code: 'NOT_ACCEPTABLE', title: 'Not acceptable' },
  408: { code: 'REQUEST_TIMEOUT', title: 'Request timeout' },
  409: { code: 'CONFLICT', title: 'Conflict' },
  410: { code: 'GONE', title: 'Gone' },
  413: { code: 'PAYLOAD_TOO_LARGE', title: 'Payload too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Unsupported media type' },
  422: { code: 'UNPROCESSABLE_ENTITY', title: 'Unprocessable entity' },
  429: { code: 'TOO_MANY_REQUESTS', title: 'Too many requests' },
  500: GENERIC_SERVER_ERROR,
  502: { code: 'BAD_GATEWAY', title: 'Bad gateway' },
  503: { code: 'SERVICE_UNAVAILABLE', title: 'Service unavailable' },
  504: { code: 'GATEWAY_TIMEOUT', title: 'Gateway timeout' },
};

/** Which HTTP status each domain error maps to. A domain error missing here is a bug -> 500. */
const DOMAIN_ERROR_STATUS: Array<
  [abstract new (...args: never[]) => DomainError, number, string]
> = [
  [NotFoundError, HttpStatus.NOT_FOUND, 'Not found'],
  [ConflictError, HttpStatus.CONFLICT, 'Conflict'],
  [UnauthenticatedError, HttpStatus.UNAUTHORIZED, 'Unauthorized'],
  [ForbiddenError, HttpStatus.FORBIDDEN, 'Forbidden'],
  [InvalidTokenError, HttpStatus.BAD_REQUEST, 'Invalid token'],
  [LimitReachedError, HttpStatus.FORBIDDEN, 'Limit reached'],
  [EmailNotVerifiedError, HttpStatus.FORBIDDEN, 'Email not verified'],
  [PlanLimitExceededError, HttpStatus.PAYMENT_REQUIRED, 'Plan limit exceeded'],
  [
    InvalidStateTransitionError,
    HttpStatus.CONFLICT,
    'Invalid state transition',
  ],
];

function statusInfo(status: number): { code: string; title: string } {
  return (
    STATUS_INFO[status] ?? { code: `HTTP_${status}`, title: `HTTP ${status}` }
  );
}

function typeUri(base: string, code: string): string {
  return `${base}/${code.toLowerCase().replace(/_/g, '-')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pulls a human message out of Nest's several HttpException response shapes. */
function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (isRecord(response)) {
    const { message } = response;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  }
  return exception.message;
}

/**
 * Errors from Express middleware (body-parser: malformed JSON, payload too large) are
 * `http-errors`: plain Errors with `status` and `expose: true` for 4xx.
 */
function clientHttpError(
  exception: unknown,
): { status: number; message: string } | undefined {
  if (!isRecord(exception)) return undefined;
  const status =
    typeof exception.status === 'number'
      ? exception.status
      : exception.statusCode;
  if (
    typeof status !== 'number' ||
    status < 400 ||
    status > 499 ||
    exception.expose !== true
  ) {
    return undefined;
  }
  return {
    status,
    message: typeof exception.message === 'string' ? exception.message : '',
  };
}

/** Prisma errors are matched by shape, so this file does not depend on the generated client. */
function prismaKnownError(exception: unknown): string | undefined {
  if (
    isRecord(exception) &&
    exception.name === 'PrismaClientKnownRequestError'
  ) {
    return typeof exception.code === 'string' ? exception.code : undefined;
  }
  return undefined;
}

function build(
  status: number,
  code: string,
  title: string,
  detail: string,
  ctx: ProblemContext,
  extra: Partial<Pick<ProblemDetails, 'errors' | 'checks' | 'upgradeUrl'>> = {},
): ProblemDetails {
  return {
    type: typeUri(ctx.docsBaseUrl, code),
    title,
    status,
    detail,
    code,
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    ...extra,
  };
}

/**
 * Turns anything that can be thrown into a safe, consistent problem document.
 *
 * Rule: nothing from a 5xx ever reaches the client except a generic message. Stack traces,
 * SQL and internal messages stay in the logs, correlated by `requestId`.
 */
export function buildProblem(
  exception: unknown,
  ctx: ProblemContext,
): ProblemDetails {
  // 1. Our own domain errors.
  if (exception instanceof DomainError) {
    const mapped = DOMAIN_ERROR_STATUS.find(
      ([type]) => exception instanceof type,
    );
    if (mapped) {
      const [, status, title] = mapped;
      return build(
        status,
        exception.code,
        title,
        exception.message,
        ctx,
        exception instanceof PlanLimitExceededError
          ? { upgradeUrl: exception.upgradeUrl }
          : {},
      );
    }
    return build(
      500,
      GENERIC_SERVER_ERROR.code,
      GENERIC_SERVER_ERROR.title,
      GENERIC_SERVER_ERROR.title,
      ctx,
    );
  }

  // 2. Request validation (DTO) failures.
  if (exception instanceof RequestValidationException) {
    return build(
      400,
      'VALIDATION_FAILED',
      'Validation failed',
      'One or more fields are invalid.',
      ctx,
      {
        errors: exception.errors,
      },
    );
  }

  // 3. Everything else Nest throws on purpose (guards, pipes, NotFoundException for unknown routes...).
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const { code, title } = statusInfo(status);
    if (status >= 500) {
      const response = exception.getResponse();
      // Terminus' readiness failure carries per-dependency status; it is intentionally generic
      // (see core/health) so it is safe to expose to load balancers and humans.
      const checks =
        status === 503 && isRecord(response) ? response.details : undefined;
      return build(
        status,
        code,
        title,
        title,
        ctx,
        checks === undefined ? {} : { checks },
      );
    }
    return build(status, code, title, httpExceptionMessage(exception), ctx);
  }

  // 4. Client errors raised by Express middleware (invalid JSON, body too large, ...).
  const clientError = clientHttpError(exception);
  if (clientError) {
    const { code, title } = statusInfo(clientError.status);
    return build(
      clientError.status,
      code,
      title,
      clientError.message || title,
      ctx,
    );
  }

  // 5. Prisma. Details (column names, constraint names) are deliberately not exposed.
  switch (prismaKnownError(exception)) {
    case 'P2002':
      return build(
        409,
        'CONFLICT',
        'Conflict',
        'A record with these values already exists.',
        ctx,
      );
    case 'P2025':
      return build(
        404,
        'NOT_FOUND',
        'Not found',
        'The requested record was not found.',
        ctx,
      );
  }

  // 6. Unknown: a bug or an outage. Generic response; the filter logs the real error.
  return build(
    500,
    GENERIC_SERVER_ERROR.code,
    GENERIC_SERVER_ERROR.title,
    GENERIC_SERVER_ERROR.title,
    ctx,
  );
}
