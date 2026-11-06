import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { EnvValidationError } from '../src/core/config/env.schema.js';
import {
  createTestApp,
  type DependencyStubs,
} from './support/create-test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBLEM_JSON = /^application\/problem\+json/;

describe('foundation (HTTP, real app configuration)', () => {
  let app: NestExpressApplication;
  let stubs: DependencyStubs;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, stubs } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    stubs.postgres = 'up';
    stubs.redis = 'up';
  });

  describe('routing and versioning', () => {
    it('serves application routes under /v1', async () => {
      await http().get('/v1/probe/ok').expect(200, { ok: true });
    });

    it('does not serve application routes without the version prefix', async () => {
      const res = await http().get('/probe/ok').expect(404);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    });

    it('answers unknown routes with a problem+json 404', async () => {
      const res = await http().get('/v1/does-not-exist').expect(404);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Not found',
      });
    });
  });

  describe('health', () => {
    it('GET /health/live is up without touching dependencies', async () => {
      stubs.postgres = 'down';
      stubs.redis = 'down';
      await http().get('/health/live').expect(200, { status: 'ok' });
    });

    it('GET /health/ready is 200 when Postgres and Redis respond', async () => {
      const res = await http().get('/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.details.postgres.status).toBe('up');
      expect(res.body.details.redis.status).toBe('up');
    });

    it.each([
      ['postgres', 'redis'],
      ['redis', 'postgres'],
    ] as const)(
      'GET /health/ready is 503 when %s is down (and %s still reports up)',
      async (down, up) => {
        stubs[down] = 'down';
        const res = await http().get('/health/ready').expect(503);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(res.body).toMatchObject({
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
        });
        expect(res.body.checks[down].status).toBe('down');
        expect(res.body.checks[up].status).toBe('up');
      },
    );

    it('does not leak hostnames, ports or driver errors from a failed check', async () => {
      stubs.postgres = 'down';
      const res = await http().get('/health/ready').expect(503);
      expect(JSON.stringify(res.body)).not.toMatch(
        /ECONNREFUSED|10\.1\.2\.3|5432/,
      );
    });

    it('reports a hung dependency as down instead of hanging the probe', async () => {
      stubs.redis = 'hang';
      const started = Date.now();
      const res = await http().get('/health/ready').expect(503);
      expect(res.body.checks.redis.status).toBe('down');
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  describe('request id', () => {
    it('generates one when absent and returns it in X-Request-Id', async () => {
      const res = await http().get('/v1/probe/ok').expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it('echoes a well-formed id from the caller', async () => {
      const res = await http()
        .get('/v1/probe/ok')
        .set('X-Request-Id', 'edge-trace-0001')
        .expect(200);
      expect(res.headers['x-request-id']).toBe('edge-trace-0001');
    });

    it('replaces a malformed id instead of trusting it', async () => {
      const res = await http()
        .get('/v1/probe/ok')
        .set('X-Request-Id', 'bad id with spaces')
        .expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it('is the same value in the response header, the request context and error bodies', async () => {
      const ok = await http().get('/v1/probe/request-id').expect(200);
      expect(ok.body.requestId).toBe(ok.headers['x-request-id']);

      const err = await http().get('/v1/probe/not-found').expect(404);
      expect(err.body.requestId).toBe(err.headers['x-request-id']);
    });

    it('gives concurrent requests their own ids (no context bleed)', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          http()
            .get('/v1/probe/request-id')
            .set('X-Request-Id', `concurrent-${String(i).padStart(4, '0')}`),
        ),
      );
      responses.forEach((res, i) => {
        expect(res.body.requestId).toBe(
          `concurrent-${String(i).padStart(4, '0')}`,
        );
      });
    });
  });

  describe('error responses (RFC 7807)', () => {
    it.each([
      ['/v1/probe/not-found', 404, 'NOT_FOUND', 'Invoice not found'],
      ['/v1/probe/conflict', 409, 'CONFLICT', 'Email already in use'],
      [
        '/v1/probe/state',
        409,
        'INVALID_STATE_TRANSITION',
        'Only DRAFT invoices can be edited',
      ],
      [
        '/v1/probe/prisma-unique',
        409,
        'CONFLICT',
        'A record with these values already exists.',
      ],
    ])('%s -> %i %s', async (path, status, code, detail) => {
      const res = await http().get(path).expect(status);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ status, code, detail });
      expect(res.body.type).toMatch(
        /^http:\/\/localhost:3000\/docs\/errors\/[a-z-]+$/,
      );
      expect(res.body.requestId).toBeDefined();
    });

    it('maps other Nest HttpExceptions faithfully', async () => {
      const res = await http().get('/v1/probe/teapot').expect(418);
      expect(res.body).toMatchObject({
        status: 418,
        code: 'HTTP_418',
        detail: 'short and stout',
      });
    });

    it('hides everything about an unexpected error behind a generic 500', async () => {
      const res = await http().get('/v1/probe/boom').expect(500);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
        detail: 'Internal server error',
      });
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3|stack|at /);
    });

    it('returns 400 (not 500) for malformed JSON', async () => {
      const res = await http()
        .post('/v1/probe/create')
        .set('Content-Type', 'application/json')
        .send('{"email": ')
        .expect(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.status).toBe(400);
    });

    it('returns 413 for an oversized body', async () => {
      const res = await http()
        .post('/v1/probe/create')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a@b.co', filler: 'x'.repeat(300_000) }))
        .expect(413);
      expect(res.body).toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    });
  });

  describe('validation', () => {
    const valid = { email: 'ada@example.com', address: { postcode: 'SW1A' } };

    it('accepts a valid body', async () => {
      await http().post('/v1/probe/create').send(valid).expect(201, valid);
    });

    it('rejects invalid fields with a per-field errors list', async () => {
      const res = await http()
        .post('/v1/probe/create')
        .send({ email: 'nope', address: { postcode: 'x' } })
        .expect(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
      const fields = res.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toContain('email');
      expect(fields).toContain('address.postcode'); // nested path
    });

    it('rejects unknown fields (mass-assignment defence)', async () => {
      const res = await http()
        .post('/v1/probe/create')
        .send({ ...valid, role: 'OWNER', organizationId: 'other-org' })
        .expect(400);
      const fields = res.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toEqual(
        expect.arrayContaining(['role', 'organizationId']),
      );
    });

    it('rejects an empty body', async () => {
      await http().post('/v1/probe/create').send({}).expect(400);
    });

    it('coerces query strings to the declared type', async () => {
      await http()
        .get('/v1/probe/page?limit=5')
        .expect(200, { limit: 5, type: 'number' });
    });

    it.each(['0', '101', 'abc', ''])(
      'rejects query limit=%s',
      async (limit) => {
        const res = await http()
          .get(`/v1/probe/page?limit=${limit}`)
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      },
    );
  });

  describe('security headers and CORS', () => {
    it('sends hardened headers and hides the framework', async () => {
      const res = await http().get('/v1/probe/ok').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('allows the configured web origin, with credentials', async () => {
      const res = await http()
        .options('/v1/probe/ok')
        .set('Origin', 'http://localhost:3001')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:3001',
      );
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it.each(['http://evil.example.com', 'http://localhost:3002', 'null'])(
      'does not grant CORS to %s',
      async (origin) => {
        const res = await http()
          .options('/v1/probe/ok')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      },
    );

    it('exposes X-Request-Id to the browser', async () => {
      const res = await http()
        .get('/v1/probe/ok')
        .set('Origin', 'http://localhost:3001')
        .expect(200);
      expect(res.headers['access-control-expose-headers']).toContain(
        'X-Request-Id',
      );
    });
  });

  describe('Swagger', () => {
    it('serves the UI at /docs with a CSP relaxed only for that page', async () => {
      const res = await http().get('/docs').redirects(1).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('serves the OpenAPI document at /docs-json, including the error schema and both auth schemes', async () => {
      const res = await http().get('/docs-json').expect(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(
        Object.keys(res.body.paths).some((path) =>
          path.includes('/health/live'),
        ),
      ).toBe(true);
      expect(
        res.body.components.schemas.ProblemDetailsDto.properties,
      ).toHaveProperty('requestId');
      expect(Object.keys(res.body.components.securitySchemes)).toEqual(
        expect.arrayContaining(['bearer', 'apiKey']),
      );
    });
  });
});

describe('request timeout', () => {
  it('fails a slow request with a clean 408 while fast ones are unaffected', async () => {
    const { app } = await createTestApp({ env: { REQUEST_TIMEOUT_MS: '50' } });
    try {
      const slow = await request(app.getHttpServer())
        .get('/v1/probe/slow')
        .expect(408);
      expect(slow.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(slow.body).toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' });
      await request(app.getHttpServer()).get('/v1/probe/ok').expect(200);
    } finally {
      await app.close();
    }
  });
});

describe('startup safety', () => {
  it('refuses to boot when the environment is invalid', async () => {
    await expect(
      createTestApp({ env: { WEB_ORIGIN: 'not-a-url' } }),
    ).rejects.toThrow(EnvValidationError);
  });

  it('names the broken variable but not its value', async () => {
    await expect(
      createTestApp({ env: { DATABASE_URL: 'mysql://root:topsecret@db/x' } }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/DATABASE_URL/),
      }),
    );
    await expect(
      createTestApp({ env: { DATABASE_URL: 'mysql://root:topsecret@db/x' } }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('topsecret'),
      }),
    );
  });
});
