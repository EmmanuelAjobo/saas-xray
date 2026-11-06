import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
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
import { RequestValidationException } from '../errors/request-validation.exception.js';
import { buildProblem } from './problem-details.js';

const ctx = {
  requestId: 'req-12345678',
  docsBaseUrl: 'https://docs.example.com/errors',
};

describe('buildProblem', () => {
  describe('domain errors', () => {
    it.each([
      [new NotFoundError('Invoice not found'), 404, 'NOT_FOUND'],
      [new ConflictError('Email already used'), 409, 'CONFLICT'],
      [
        new InvalidStateTransitionError('Only DRAFT invoices can be edited'),
        409,
        'INVALID_STATE_TRANSITION',
      ],
      [
        new UnauthenticatedError('Invalid email or password.'),
        401,
        'UNAUTHENTICATED',
      ],
      [new ForbiddenError('Cross-origin request refused.'), 403, 'FORBIDDEN'],
      [
        new LimitReachedError('You can own at most 5 organisations.'),
        403,
        'LIMIT_REACHED',
      ],
      [
        new EmailNotVerifiedError('Verify your email first.'),
        403,
        'EMAIL_NOT_VERIFIED',
      ],
      [
        new PlanLimitExceededError(
          'Seat limit reached.',
          'https://app.example.com/billing',
        ),
        402,
        'PLAN_LIMIT_EXCEEDED',
      ],
      [
        new InvalidTokenError('This link is invalid or has expired.'),
        400,
        'INVALID_TOKEN',
      ],
    ])('maps %s', (error, status, code) => {
      const problem = buildProblem(error, ctx);
      expect(problem).toMatchObject({
        status,
        code,
        detail: error.message,
        requestId: 'req-12345678',
      });
      expect(problem.type).toBe(
        `https://docs.example.com/errors/${code.toLowerCase().replace(/_/g, '-')}`,
      );
    });

    it('turns an unmapped domain error into a generic 500 (a bug must not leak details)', () => {
      class Forgotten extends DomainError {
        readonly code = 'FORGOTTEN';
      }
      const problem = buildProblem(
        new Forgotten('internal: table users has 3 rows'),
        ctx,
      );
      expect(problem.status).toBe(500);
      expect(problem.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(problem)).not.toContain('table users');
    });
  });

  describe('validation', () => {
    it('returns 400 with a field-level errors list', () => {
      const problem = buildProblem(
        new RequestValidationException([
          { field: 'email', message: 'email must be an email' },
        ]),
        ctx,
      );
      expect(problem).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'email', message: 'email must be an email' }],
      });
    });
  });

  describe('Nest HttpExceptions', () => {
    it.each([
      [new UnauthorizedException(), 401, 'UNAUTHORIZED'],
      [new ForbiddenException('You may not do that'), 403, 'FORBIDDEN'],
      [new NotFoundException('Cannot GET /nope'), 404, 'NOT_FOUND'],
      [new BadRequestException('bad'), 400, 'BAD_REQUEST'],
      [new HttpException('teapot', 418), 418, 'HTTP_418'],
    ])('maps %s', (error, status, code) => {
      expect(buildProblem(error, ctx)).toMatchObject({ status, code });
    });

    it('joins array messages (class-validator style)', () => {
      const problem = buildProblem(
        new BadRequestException({ message: ['a is bad', 'b is bad'] }),
        ctx,
      );
      expect(problem.detail).toBe('a is bad; b is bad');
    });

    it('never forwards the message of a 5xx HttpException', () => {
      const problem = buildProblem(
        new HttpException('db password is hunter2', 500),
        ctx,
      );
      expect(problem.status).toBe(500);
      expect(problem.detail).toBe('Internal server error');
      expect(JSON.stringify(problem)).not.toContain('hunter2');
    });

    it('exposes the readiness breakdown on a 503', () => {
      const problem = buildProblem(
        new ServiceUnavailableException({
          status: 'error',
          details: { postgres: { status: 'down', message: 'unavailable' } },
        }),
        ctx,
      );
      expect(problem).toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        checks: { postgres: { status: 'down', message: 'unavailable' } },
      });
    });
  });

  describe('Express middleware errors (http-errors shape)', () => {
    it('maps malformed JSON to 400 and keeps the safe parser message', () => {
      const error = Object.assign(new Error('Unexpected token } in JSON'), {
        status: 400,
        statusCode: 400,
        expose: true,
        type: 'entity.parse.failed',
      });
      expect(buildProblem(error, ctx)).toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    });

    it('maps an oversized body to 413', () => {
      const error = Object.assign(new Error('request entity too large'), {
        status: 413,
        expose: true,
      });
      expect(buildProblem(error, ctx)).toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    });

    it('does not trust a status on an error that is not marked safe to expose', () => {
      const error = Object.assign(new Error('internal oops'), {
        status: 400,
        expose: false,
      });
      expect(buildProblem(error, ctx).status).toBe(500);
    });
  });

  describe('Prisma errors (matched by shape)', () => {
    const prismaError = (code: string) =>
      Object.assign(
        new Error('Unique constraint failed on the fields: (`email`)'),
        {
          name: 'PrismaClientKnownRequestError',
          code,
          meta: { target: ['email'] },
        },
      );

    it('maps P2002 (unique violation) to 409 without leaking the column', () => {
      const problem = buildProblem(prismaError('P2002'), ctx);
      expect(problem).toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(JSON.stringify(problem)).not.toContain('email');
    });

    it('maps P2025 (record not found) to 404', () => {
      expect(buildProblem(prismaError('P2025'), ctx)).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it('treats any other Prisma error as an opaque 500', () => {
      expect(buildProblem(prismaError('P1001'), ctx)).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('unknown errors', () => {
    it.each([
      new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      'a thrown string',
      { weird: 'object' },
      null,
      undefined,
    ])('returns a generic 500 for %s', (error) => {
      const problem = buildProblem(error, ctx);
      expect(problem).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
        title: 'Internal server error',
        detail: 'Internal server error',
      });
      expect(JSON.stringify(problem)).not.toMatch(
        /ECONNREFUSED|10\.0\.0\.5|undefined|weird/,
      );
    });
  });

  it('omits requestId when there is none', () => {
    expect(
      buildProblem(new NotFoundError('x'), { docsBaseUrl: ctx.docsBaseUrl }),
    ).not.toHaveProperty('requestId');
  });
});
