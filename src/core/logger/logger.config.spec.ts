import { Writable } from 'node:stream';
import pino from 'pino';
import {
  REDACT_CENSOR,
  REDACT_PATHS,
  buildPinoHttpOptions,
} from './logger.config.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } },
    stream,
  );
  return { logger, output: () => lines.join('') };
}

describe('log redaction', () => {
  it('censors credentials in request headers', () => {
    const { logger, output } = capture();
    logger.info({
      req: {
        headers: {
          authorization: 'Bearer eyJ.super.secret',
          cookie: 'refresh_token=abc123',
          'x-api-key': 'sk_test_ab12cd34_topsecret',
          accept: 'application/json',
        },
      },
    });
    const line = output();
    expect(line).not.toContain('super.secret');
    expect(line).not.toContain('abc123');
    expect(line).not.toContain('topsecret');
    expect(line).toContain('application/json'); // non-secret headers stay useful
    expect(line).toContain(REDACT_CENSOR);
  });

  it('censors Set-Cookie on responses', () => {
    const { logger, output } = capture();
    logger.info({
      res: {
        headers: { 'set-cookie': 'refresh_token=rotated-secret; HttpOnly' },
      },
    });
    expect(output()).not.toContain('rotated-secret');
  });

  it.each([
    'password',
    'newPassword',
    'currentPassword',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'secret',
  ])('censors a "%s" field in a logged body', (field) => {
    const { logger, output } = capture();
    logger.info({
      body: { [field]: 'do-not-log-me', email: 'ada@example.com' },
    });
    expect(output()).not.toContain('do-not-log-me');
    expect(output()).toContain('ada@example.com');
  });
});

describe('buildPinoHttpOptions', () => {
  const options = buildPinoHttpOptions({ level: 'info', pretty: false });
  const res = (statusCode: number) => ({ statusCode }) as never;

  it('logs 5xx and errors as error, 4xx as warn, the rest as info', () => {
    const level = options.customLogLevel!;
    expect(level({} as never, res(200), undefined)).toBe('info');
    expect(level({} as never, res(302), undefined)).toBe('info');
    expect(level({} as never, res(404), undefined)).toBe('warn');
    expect(level({} as never, res(500), undefined)).toBe('error');
    expect(level({} as never, res(200), new Error('boom'))).toBe('error');
  });

  it('does not log health probes', () => {
    const ignore = (
      options.autoLogging as { ignore: (req: unknown) => boolean }
    ).ignore;
    expect(ignore({ url: '/health/live' })).toBe(true);
    expect(ignore({ url: '/health/ready' })).toBe(true);
    expect(ignore({ url: '/v1/orgs' })).toBe(false);
  });

  it('only enables the pretty transport when asked (JSON in production)', () => {
    expect(options).not.toHaveProperty('transport');
    expect(
      buildPinoHttpOptions({ level: 'debug', pretty: true }),
    ).toHaveProperty('transport');
  });

  it('reuses the request id decided by the middleware', () => {
    expect(
      options.genReqId!(
        { headers: { 'x-request-id': 'abc-12345678' } } as never,
        {} as never,
      ),
    ).toBe('abc-12345678');
  });
});
