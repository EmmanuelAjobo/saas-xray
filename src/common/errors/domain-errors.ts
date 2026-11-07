/**
 * Domain errors are plain classes thrown by services. They know nothing about HTTP: the
 * GlobalExceptionFilter maps them to status codes. That keeps services reusable from
 * workers, WebSocket handlers and tests.
 *
 * `code` is the stable, machine-readable identifier clients may switch on. Never change a
 * code once released; add a new one instead.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The resource does not exist, or the caller is not allowed to know that it does. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

/** The request conflicts with current state (duplicate email, pending invite, ...). */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

/** An illegal state-machine move, e.g. editing a SENT invoice. */
export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';
}

/** Missing, wrong or expired credentials. Messages must stay generic (no account enumeration). */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
}

/** Authenticated, but not allowed to do this. */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}

/** A per-user or per-plan quota is used up (organisations owned, seats, ...). */
export class LimitReachedError extends DomainError {
  readonly code = 'LIMIT_REACHED';
}

/** The action needs a verified email address (inviting people, billing). */
export class EmailNotVerifiedError extends DomainError {
  readonly code = 'EMAIL_NOT_VERIFIED';
}

/** The organisation's plan does not allow this (seats, ...). Answered with 402 and an upgrade link. */
export class PlanLimitExceededError extends DomainError {
  readonly code = 'PLAN_LIMIT_EXCEEDED';
  constructor(
    message: string,
    readonly upgradeUrl: string,
  ) {
    super(message);
  }
}

/** The service cannot take this request right now (capacity). The caller may try again later. */
export class TemporarilyUnavailableError extends DomainError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';
}

/** An email-verification, password-reset or invitation token that is unknown, used or expired. */
export class InvalidTokenError extends DomainError {
  readonly code = 'INVALID_TOKEN';
}
