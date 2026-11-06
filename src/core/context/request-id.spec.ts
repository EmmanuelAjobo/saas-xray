import type { NextFunction, Request, Response } from 'express';
import { getRequestIdFromRequest, requestIdMiddleware } from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(incoming?: string | string[]) {
  const req = {
    headers: incoming === undefined ? {} : { 'x-request-id': incoming },
  } as unknown as Request;
  const setHeader = vi.fn();
  const next = vi.fn() as unknown as NextFunction;
  requestIdMiddleware(req, { setHeader } as unknown as Response, next);
  return { req, setHeader, next };
}

describe('requestIdMiddleware', () => {
  it('generates a UUID when the client sends none', () => {
    const { req, setHeader, next } = run();
    expect(req.headers['x-request-id']).toMatch(UUID);
    expect(setHeader).toHaveBeenCalledWith(
      'X-Request-Id',
      req.headers['x-request-id'],
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('reuses a well-formed incoming id (so traces span proxy -> API)', () => {
    const { req, setHeader } = run('trace_ABC-1234567890');
    expect(req.headers['x-request-id']).toBe('trace_ABC-1234567890');
    expect(setHeader).toHaveBeenCalledWith(
      'X-Request-Id',
      'trace_ABC-1234567890',
    );
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['has spaces', 'abc def 12345'],
    ['log injection attempt', 'abcdefgh\n{"level":"fatal"}'],
    ['has quotes', 'abcdefgh"12345'],
    ['empty', ''],
  ])('replaces an invalid incoming id (%s)', (_label, bad) => {
    const { req } = run(bad);
    expect(req.headers['x-request-id']).toMatch(UUID);
  });

  it('replaces a duplicated header (arrives as an array/joined value)', () => {
    expect(run(['abcdefgh1', 'abcdefgh2']).req.headers['x-request-id']).toMatch(
      UUID,
    );
    expect(run('abcdefgh1, abcdefgh2').req.headers['x-request-id']).toMatch(
      UUID,
    );
  });
});

describe('getRequestIdFromRequest', () => {
  it('reads the header set by the middleware', () => {
    expect(
      getRequestIdFromRequest({ headers: { 'x-request-id': 'known-id-1234' } }),
    ).toBe('known-id-1234');
  });

  it('falls back to a fresh UUID so isolated tests never see an undefined id', () => {
    expect(getRequestIdFromRequest({ headers: {} })).toMatch(UUID);
  });
});
