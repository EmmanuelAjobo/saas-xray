import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { testConfig } from '../../../test/support/test-config.js';
import { MemoryXrayStore } from './memory-xray.store.js';
import { authCheckEvent, emailEvent } from './xray.events.js';
import { XrayMiddleware } from './xray.middleware.js';
import { XrayService } from './xray.service.js';
import { recordDatabaseQuery, recordXrayStep } from './xray.trace.js';

const ORG = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const OTHER = '0198a2b4-5d6e-7f80-9a1b-bbbbbbbbbbbb';

function setup(env: Record<string, string> = {}) {
  const config = testConfig(env);
  const store = new MemoryXrayStore(config);
  const xray = new XrayService(store, config);
  const middleware = new XrayMiddleware(xray);
  return { store, xray, middleware };
}

/** Plays one request through the middleware; `handler` is "the rest of the app". */
async function request(
  middleware: XrayMiddleware,
  options: {
    tenant?: { organizationId: string; role: string };
    route?: string;
    status?: number;
    handler?: () => Promise<void> | void;
  } = {},
) {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: { 'x-request-id': 'req-12345678' },
    route:
      'route' in options
        ? { path: options.route }
        : { path: '/v1/orgs/:orgId/invoices/:id/send' },
  }) as unknown as Request & { tenant?: unknown };
  const res = Object.assign(new EventEmitter(), {
    statusCode: options.status ?? 200,
  }) as unknown as Response;

  await new Promise<void>((resolve, reject) => {
    const next: NextFunction = () => {
      Promise.resolve(options.handler?.())
        .then(() => {
          if (options.tenant) req.tenant = options.tenant;
          res.emit('finish');
          resolve();
        })
        .catch(reject);
    };
    middleware.use(req, res, next);
  });
}

describe('XrayMiddleware', () => {
  it('publishes a finished tenant request to ITS organisation: steps, then the database summary, then the request', async () => {
    const { store, xray, middleware } = setup();
    await request(middleware, {
      tenant: { organizationId: ORG, role: 'ADMIN' },
      handler: () => {
        recordXrayStep(
          authCheckEvent({
            ts: 1,
            role: 'ADMIN',
            permission: 'invoice:send',
            allowed: true,
          }),
        );
        recordDatabaseQuery('Invoice', 3);
      },
    });
    await xray.flush();

    const events = await store.latest(ORG, 20);
    expect(events.map((e) => e.kind)).toEqual([
      'auth.check',
      'db.queries',
      'http.request',
    ]);
    expect(events.every((e) => e.requestId === 'req-12345678')).toBe(true);
    expect(events.at(-1)?.meta).toMatchObject({
      method: 'POST',
      route: '/v1/orgs/:orgId/invoices/:id/send',
      status: 200,
    });
    expect(await store.latest(OTHER, 20)).toEqual([]);
  });

  it('records the FINAL status, so a refusal by a guard is visible', async () => {
    const { store, xray, middleware } = setup();
    await request(middleware, {
      tenant: { organizationId: ORG, role: 'MEMBER' },
      status: 403,
    });
    await xray.flush();
    const [http] = await store.latest(ORG, 5);
    expect(http?.meta.status).toBe(403);
    expect(http?.severity).toBe('warn');
  });

  it('publishes NOTHING when the caller was never verified as a member (no tenant on the request)', async () => {
    const { store, xray, middleware } = setup();
    await request(middleware, { status: 404 });
    await xray.flush();
    expect(await store.latest(ORG, 20)).toEqual([]);
    expect(await store.latest(OTHER, 20)).toEqual([]);
  });

  it('does not record the X-ray reading its own events', async () => {
    const { store, xray, middleware } = setup();
    for (const route of [
      '/v1/orgs/:orgId/xray/events',
      '/v1/orgs/:orgId/xray/stream',
      '/v1/orgs/:orgId/xray',
    ]) {
      await request(middleware, {
        tenant: { organizationId: ORG, role: 'OWNER' },
        route,
      });
    }
    await xray.flush();
    expect(await store.latest(ORG, 20)).toEqual([]);
  });

  it('still records a route that merely starts with the letters "xray"', async () => {
    const { store, xray, middleware } = setup();
    await request(middleware, {
      tenant: { organizationId: ORG, role: 'OWNER' },
      route: '/v1/orgs/:orgId/xraylike',
    });
    await xray.flush();
    expect(await store.latest(ORG, 20)).toHaveLength(1);
  });

  it('publishes nothing when the request matched no route', async () => {
    const { store, xray, middleware } = setup();
    await request(middleware, {
      tenant: { organizationId: ORG, role: 'OWNER' },
      route: undefined,
    });
    await xray.flush();
    expect(await store.latest(ORG, 20)).toEqual([]);
  });

  it('sends work recorded AFTER the response (a background email) to the same organisation, with the same request id', async () => {
    const { store, xray, middleware } = setup();
    let later: () => void = () => undefined;
    await request(middleware, {
      tenant: { organizationId: ORG, role: 'OWNER' },
      handler: () => {
        // Started inside the request, finishes after the response has gone out.
        setTimeout(() => later(), 0);
        later = () =>
          recordXrayStep(
            emailEvent({ ts: 2, template: 'invoice-sent', sent: true }),
          );
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await xray.flush();

    const events = await store.latest(ORG, 20);
    expect(events.at(-1)?.kind).toBe('email.sent');
    expect(events.at(-1)?.requestId).toBe('req-12345678');
    expect(await store.latest(OTHER, 20)).toEqual([]);
  });

  it('drops late work from a request that had no verified organisation', async () => {
    const { store, xray, middleware } = setup();
    await request(middleware, {
      handler: () => {
        setTimeout(
          () =>
            recordXrayStep(emailEvent({ ts: 2, template: 'x', sent: true })),
          0,
        );
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await xray.flush();
    expect(await store.latest(ORG, 20)).toEqual([]);
  });

  it('does not even open a trace when XRAY_ENABLED=false', async () => {
    const { store, xray, middleware } = setup({ XRAY_ENABLED: 'false' });
    await request(middleware, {
      tenant: { organizationId: ORG, role: 'OWNER' },
      handler: () => recordDatabaseQuery('Invoice', 1),
    });
    await xray.flush();
    expect(await store.latest(ORG, 20)).toEqual([]);
  });

  it('never lets a failure inside the X-ray surface (the response is already out)', async () => {
    const { xray, middleware } = setup();
    vi.spyOn(xray, 'publish').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(
      request(middleware, { tenant: { organizationId: ORG, role: 'OWNER' } }),
    ).resolves.toBeUndefined();
  });
});
