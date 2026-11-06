import { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/create-test-app.js';

interface LogLine {
  level: number;
  requestId?: string;
  msg?: string;
  req?: { id?: string; headers?: Record<string, unknown>; url?: string };
  res?: { statusCode?: number; headers?: Record<string, unknown> };
  [key: string]: unknown;
}

describe('request logging (real pino-http output)', () => {
  let app: NestExpressApplication;
  let raw = '';

  const lines = (): LogLine[] =>
    raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  const requestLogs = (id: string) =>
    lines().filter((line) => line.requestId === id);

  beforeAll(async () => {
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        raw += chunk.toString();
        callback();
      },
    });
    ({ app } = await createTestApp({ logStream }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    raw = '';
  });

  it('writes one structured line per request, tagged with the request id', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe/ok')
      .set('X-Request-Id', 'log-trace-0001')
      .expect(200);

    const logs = requestLogs('log-trace-0001');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 30, // info
      req: { id: 'log-trace-0001', url: '/v1/probe/ok' },
      res: { statusCode: 200 },
    });
  });

  it('never writes credentials to the log, but keeps useful headers', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe/ok')
      .set('X-Request-Id', 'log-trace-0002')
      .set('Authorization', 'Bearer eyJhbGciOi.very-secret-jwt')
      .set('Cookie', 'refresh_token=very-secret-cookie')
      .set('X-API-Key', 'sk_test_ab12cd34_very-secret-key')
      .expect(200);

    expect(raw).not.toContain('very-secret-jwt');
    expect(raw).not.toContain('very-secret-cookie');
    expect(raw).not.toContain('very-secret-key');

    const [line] = requestLogs('log-trace-0002');
    expect(line.req?.headers?.authorization).toBe('[REDACTED]');
    expect(line.req?.headers?.cookie).toBe('[REDACTED]');
    expect(line.req?.headers?.['x-api-key']).toBe('[REDACTED]');
    expect(
      line.req?.headers?.['user-agent'] ?? line.req?.headers?.host,
    ).toBeDefined();
  });

  it('logs client errors as warn and server errors as error', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe/not-found')
      .set('X-Request-Id', 'log-trace-0003');
    await request(app.getHttpServer())
      .get('/v1/probe/boom')
      .set('X-Request-Id', 'log-trace-0004');

    expect(requestLogs('log-trace-0003')[0].level).toBe(40); // warn
    // The 500 produces two lines for the same request: the filter's error with the
    // stack, and the request-completed line. Both carry the request id.
    const serverLogs = requestLogs('log-trace-0004');
    expect(serverLogs.length).toBeGreaterThanOrEqual(1);
    expect(serverLogs.every((line) => line.level === 50)).toBe(true); // error
  });

  it('logs the full error for a 500 (the client only sees a generic message)', async () => {
    await request(app.getHttpServer())
      .get('/v1/probe/boom')
      .set('X-Request-Id', 'log-trace-0005')
      .expect(500);

    expect(raw).toContain('ECONNREFUSED'); // the operator can see the real cause
    expect(raw).toContain('Unhandled exception');
  });

  it('does not log health probes', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(raw).toBe('');
  });
});
