import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { XrayService } from '../src/core/xray/xray.service.js';
// The page's own scripts, exactly as the browser runs them (plain JavaScript, no types).
// @ts-expect-error no declaration file for plain JS
import * as actions from '../web/js/actions.js';
// @ts-expect-error no declaration file for plain JS
import { createApi } from '../web/js/api.js';
// @ts-expect-error no declaration file for plain JS
import { createTimeline } from '../web/js/timeline.js';
// @ts-expect-error no declaration file for plain JS
import { startXrayStream } from '../web/js/xray-stream.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';

/**
 * Drives the demo page's real client code (API client, actions, live stream, timeline)
 * against the real app and database over a real socket. A cookie jar stands in for the
 * browser, so the refresh-cookie flow is exercised too. This is what proves the page and the
 * API agree on every response shape the page relies on.
 */
describe('the demo page’s client code against the real API', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let xray: XrayService;
  const stoppers: Array<() => void> = [];

  const origin = () =>
    `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  /**
   * A browser-like fetch: absolute URL from a path, one client IP per "browser", and a cookie
   * jar for the refresh cookie (sent only where its Path says it should be).
   */
  function browser(ip: string) {
    const jar = new Map<string, string>();
    const fetchImpl = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-forwarded-for', ip);
      if (
        init.credentials !== 'omit' &&
        path.startsWith('/v1/auth') &&
        jar.size
      ) {
        headers.set(
          'cookie',
          [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        );
      }
      const response = await fetch(origin() + path, { ...init, headers });
      if (init.credentials !== 'omit') {
        for (const line of response.headers.getSetCookie()) {
          const [pair] = line.split(';');
          const [name, value] = (pair ?? '').split('=');
          if (!name) continue;
          if (
            /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(line) ||
            value === ''
          ) {
            jar.delete(name);
          } else {
            jar.set(name, value ?? '');
          }
        }
      }
      return response;
    };
    return { fetchImpl, jar };
  }

  beforeAll(async () => {
    ({ app } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1' },
    }));
    db = app.get(PrismaService);
    xray = app.get(XrayService);
    await resetDb(db);
  });
  afterAll(async () => {
    for (const stop of stoppers) stop();
    await app.close();
    await resetDb(db);
  });

  it('plays the whole demo: start, look around, break the rules, change role, peek as a stranger, and watch the X-ray narrate it', async () => {
    const visitor = browser('10.20.0.1');
    const api = createApi({ fetchImpl: visitor.fetchImpl });

    // 1. "Start the live demo"
    const session = await api.startDemo();
    expect(session.accessToken).toBeTruthy();
    expect(visitor.jar.has('refresh_token')).toBe(true);

    // 2. The page finds the visitor's company (this is what enter() reads).
    const orgs = await api.request('GET', '/v1/orgs');
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ role: 'OWNER' });
    expect(typeof orgs[0].name).toBe('string');
    const orgId: string = orgs[0].id;

    // 3. The live X-ray stream, read by the page's own stream client.
    const timeline = createTimeline();
    const states: string[] = [];
    const stream = startXrayStream({
      url: `/v1/orgs/${orgId}/xray/stream`,
      getToken: () => api.token,
      refreshToken: api.refresh,
      onEvent: (event: unknown) => timeline.add(event),
      onState: (state: string) => states.push(state),
      fetchImpl: visitor.fetchImpl,
    });
    stoppers.push(stream.stop);
    const until = async (check: () => boolean, ms = 8000) => {
      const stop = Date.now() + ms;
      while (!check()) {
        if (Date.now() > stop) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    await until(() => states.includes('live'));

    // 4. The page loads the lists. Every field the screen draws must be there.
    const invoices = await api.request(
      'GET',
      `/v1/orgs/${orgId}/invoices?limit=50`,
    );
    const clients = await api.request(
      'GET',
      `/v1/orgs/${orgId}/clients?limit=50`,
    );
    expect(invoices.data.length).toBeGreaterThanOrEqual(5);
    for (const invoice of invoices.data) {
      expect(invoice).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          number: expect.stringMatching(/^INV-\d{4}$/),
          status: expect.stringMatching(/^(DRAFT|SENT|PAID|OVERDUE|VOID)$/),
          totalCents: expect.any(Number),
          currency: expect.stringMatching(/^[A-Z]{3}$/),
          client: expect.objectContaining({ name: expect.any(String) }),
        }),
      );
    }
    expect(clients.data.length).toBeGreaterThanOrEqual(1);

    // 5. Buttons that work.
    const created = await actions.createInvoice(
      api,
      orgId,
      clients.data[0].id,
      0,
    );
    expect(created).toMatchObject({ tone: 'ok' });
    expect(created.text).toMatch(/INV-\d{4}/);
    const afterCreate = await api.request(
      'GET',
      `/v1/orgs/${orgId}/invoices?limit=50`,
    );
    const draft = afterCreate.data.find(
      (invoice: { status: string; number: string }) =>
        invoice.status === 'DRAFT' && created.text.includes(invoice.number),
    );
    expect(draft).toBeDefined();
    expect(await actions.sendInvoice(api, orgId, draft)).toMatchObject({
      tone: 'ok',
    });

    // The email a demo sandbox "sends" lands in its Outbox: every field the page shows is there.
    const outbox = await api.request('GET', `/v1/orgs/${orgId}/outbox`);
    expect(outbox.data).toHaveLength(1);
    expect(outbox.data[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        ts: expect.any(Number),
        to: expect.stringContaining('@'),
        subject: expect.stringContaining(draft.number),
        text: expect.stringContaining(draft.number),
      }),
    );

    // 6. A button that must be refused: paying a draft.
    const sentAlready = await actions.payADraft(
      api,
      orgId,
      afterCreate.data,
      clients.data[0].id,
    );
    expect(sentAlready.tone).toBe('refused');
    expect(sentAlready.text).toContain('Refused (409)');

    // 7. Role change, then the same kind of action is refused for a Member.
    expect(await actions.createClient(api, orgId, 1)).toMatchObject({
      tone: 'ok',
    });
    await api.switchRole('MEMBER');
    const asMember = await actions.createClient(api, orgId, 2);
    expect(asMember.tone).toBe('refused');
    expect(asMember.text).toContain('Refused (403)');

    // 8. A stranger from another company peeks: 404, with the page's own explanation.
    const peek = await actions.peekAsStranger(api, orgId);
    expect(peek.tone).toBe('refused');
    expect(peek.text).toContain('404');

    // 9. The X-ray narrated all of it, grouped one card per click.
    await xray.flush();
    await until(() =>
      timeline
        .groups()
        .some(
          (g: { request?: { meta: { status: number } } }) =>
            g.request?.meta.status === 403,
        ),
    );
    const groups = timeline.groups() as Array<{
      title: string;
      severity: string;
      events: Array<{ kind: string; meta: Record<string, unknown> }>;
      request?: { meta: Record<string, unknown> };
    }>;
    const byTitle = (title: string, status: number) =>
      groups.find(
        (g) => g.title === title && g.request?.meta.status === status,
      );

    // The create, and the email that was skipped (demo sandbox) joined to the SEND click.
    expect(byTitle('POST /invoices', 201)?.severity).toBe('success');
    const send = groups.find((g) => g.title.includes('/send'));
    expect(send?.events.map((e) => e.kind)).toContain('email.captured');

    // The refusal of paying a draft is a warning card with its database work.
    const pay = groups.find((g) => g.request?.meta.status === 409);
    expect(pay?.title).toBe('POST /invoices/:id/pay');
    expect(pay?.severity).toBe('warn');

    // The Member's refusal shows WHICH permission was missing, before any data was touched.
    const forbidden = groups.find((g) => g.request?.meta.status === 403);
    expect(forbidden?.severity).toBe('warn');
    const denied = forbidden?.events.find((e) => e.kind === 'auth.check');
    expect(denied?.meta).toMatchObject({
      role: 'MEMBER',
      permission: 'client:write',
      allowed: false,
    });
    expect(forbidden?.events.map((e) => e.kind)).not.toContain('db.queries');

    // The stranger's attempt left NO trace in the visitor's X-ray.
    expect(groups.some((g) => g.request?.meta.status === 404)).toBe(false);

    // 10. An expired access token is renewed invisibly from the cookie.
    api.setToken('an-expired-or-forged-token');
    const refreshed = await api.request('GET', '/v1/orgs');
    expect(refreshed).toHaveLength(1);
    expect(api.token).not.toBe('an-expired-or-forged-token');

    // 11. "Leave" ends the session: the cookie can no longer renew anything.
    await api.request('POST', '/v1/auth/logout');
    api.setToken(undefined);
    expect(await api.refresh()).toBe(false);

    stream.stop();
  }, 60_000);

  it('keeps two visitors apart: one cannot see the other’s invoices, and each X-ray is their own', async () => {
    const one = createApi({ fetchImpl: browser('10.20.0.2').fetchImpl });
    const two = createApi({ fetchImpl: browser('10.20.0.3').fetchImpl });
    await one.startDemo();
    await two.startDemo();
    const orgOne = (await one.request('GET', '/v1/orgs'))[0].id as string;
    const orgTwo = (await two.request('GET', '/v1/orgs'))[0].id as string;
    expect(orgOne).not.toBe(orgTwo);

    // Visitor two asks for visitor one's company with their own valid token: 404, never data.
    const refused = await two
      .request('GET', `/v1/orgs/${orgOne}/invoices`)
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 404 });

    // Each only ever sees events about their own company.
    await one.request('GET', `/v1/orgs/${orgOne}/clients`);
    await two.request('GET', `/v1/orgs/${orgTwo}/tasks`);
    await xray.flush();
    const eventsOf = async (api: { request: Function }, org: string) =>
      (await api.request('GET', `/v1/orgs/${org}/xray/events`)).data.map(
        (e: { meta: Record<string, string> }) => e.meta.route,
      ) as string[];
    const seenByOne = await eventsOf(one, orgOne);
    const seenByTwo = await eventsOf(two, orgTwo);
    expect(seenByOne).toContain('/v1/orgs/:orgId/clients');
    expect(seenByOne).not.toContain('/v1/orgs/:orgId/tasks');
    expect(seenByTwo).toContain('/v1/orgs/:orgId/tasks');
    expect(seenByTwo).not.toContain('/v1/orgs/:orgId/clients');
  }, 60_000);
});
