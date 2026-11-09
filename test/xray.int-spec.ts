import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { MemoryXrayStore } from '../src/core/xray/memory-xray.store.js';
import { XrayService } from '../src/core/xray/xray.service.js';
import { XRAY_STORE } from '../src/core/xray/xray.store.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

interface Event {
  id: string;
  requestId?: string;
  kind: string;
  severity: string;
  title: string;
  summary: string;
  meta: Record<string, string | number | boolean | null>;
}

describe('Backend X-ray (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let xray: XrayService;
  let store: MemoryXrayStore;
  let background: Awaited<ReturnType<typeof createTestApp>>['background'];
  let mail: Awaited<ReturnType<typeof createTestApp>>['mail'];
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let otherOrgId: string;

  /** What the X-ray currently shows for an organisation, as `viewer` sees it. */
  const eventsOf = async (viewer: TestUser, id = orgId): Promise<Event[]> => {
    await background.drain();
    await xray.flush();
    const res = await http('get', `/v1/orgs/${id}/xray/events?limit=200`, {
      bearer: viewer.token,
    }).expect(200);
    return (res.body as { data: Event[] }).data;
  };
  const kinds = (events: Event[]) => events.map((e) => e.kind);

  beforeAll(async () => {
    ({ app, background, mail } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1' },
    }));
    db = app.get(PrismaService);
    xray = app.get(XrayService);
    store = app.get<MemoryXrayStore>(XRAY_STORE);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
    owner = await createAuthedUser(app, db, 'owner@example.com');
    member = await createAuthedUser(app, db, 'member@example.com');
    outsider = await createAuthedUser(app, db, 'outsider@example.com');
    ({ id: orgId } = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
      { user: member, role: 'MEMBER' },
    ]));
    ({ id: otherOrgId } = await createOrgWith(db, 'other', [
      { user: outsider, role: 'OWNER' },
    ]));
  });

  describe('what a request leaves behind', () => {
    it('shows the journey of one click: membership, permission, database, answer, all under one request id', async () => {
      const created = await http('post', `/v1/orgs/${orgId}/clients`, {
        bearer: owner.token,
        body: { name: 'Northwind', email: 'billing@northwind.example' },
      }).expect(201);
      const requestId = created.headers['x-request-id'] as string;

      const events = await eventsOf(owner);
      expect(kinds(events)).toEqual([
        'tenant.check',
        'auth.check',
        'db.queries',
        'http.request',
      ]);
      expect(events.every((e) => e.requestId === requestId)).toBe(true);

      const [tenant, auth, queries, request] = events as [
        Event,
        Event,
        Event,
        Event,
      ];
      expect(tenant.meta).toEqual({ role: 'OWNER' });
      expect(auth.meta).toEqual({
        role: 'OWNER',
        permission: 'client:write',
        allowed: true,
      });
      expect(Number(queries.meta.queries)).toBeGreaterThanOrEqual(1);
      expect(String(queries.meta.models)).toContain('Client');
      expect(request.meta).toMatchObject({
        method: 'POST',
        route: '/v1/orgs/:orgId/clients',
        status: 201,
      });
      expect(request.severity).toBe('success');
    });

    it('shows a refusal by a guard, with the reason, and the request still gets its final status', async () => {
      const sandboxMember = await createAuthedUser(
        app,
        db,
        'visitor@example.com',
        { isDemo: true },
      );
      const { id: sandbox } = await createOrgWith(db, 'sandbox', [
        { user: sandboxMember, role: 'MEMBER' },
      ]);
      await db.organization.update({
        where: { id: sandbox },
        data: { isDemo: true },
      });

      await http('post', `/v1/orgs/${sandbox}/clients`, {
        bearer: sandboxMember.token,
        body: { name: 'Nope', email: 'nope@example.com' },
      }).expect(403);

      const events = await eventsOf(sandboxMember, sandbox);
      expect(kinds(events)).toEqual([
        'tenant.check',
        'auth.check',
        'http.request',
      ]);
      expect(events[1]).toMatchObject({
        severity: 'warn',
        meta: { role: 'MEMBER', permission: 'client:write', allowed: false },
      });
      expect(events[1]?.summary).toContain('Refused before any data');
      expect(events[2]?.meta.status).toBe(403);
      // Refused before the database was touched, so there is no database summary.
      expect(kinds(events)).not.toContain('db.queries');
    });

    it('shows a business-rule refusal (paying a draft) as a 409 with its database work', async () => {
      const made = await http('post', `/v1/orgs/${orgId}/clients`, {
        bearer: owner.token,
        body: { name: 'Acme', email: 'billing@acme.example' },
      }).expect(201);
      const invoice = await http('post', `/v1/orgs/${orgId}/invoices`, {
        bearer: owner.token,
        body: { clientId: (made.body as { id: string }).id },
      }).expect(201);
      await http(
        'post',
        `/v1/orgs/${orgId}/invoices/${(invoice.body as { id: string }).id}/pay`,
        { bearer: owner.token },
      ).expect(409);

      const last = (await eventsOf(owner)).at(-1) as Event;
      expect(last.meta).toMatchObject({
        route: '/v1/orgs/:orgId/invoices/:id/pay',
        status: 409,
      });
      expect(last.summary).toContain('conflicts with the current state');
    });

    it('says the email was captured in the Outbox (not sent) in a demo sandbox', async () => {
      const visitor = await createAuthedUser(app, db, 'demo@example.com', {
        isDemo: true,
      });
      const { id: sandbox } = await createOrgWith(db, 'demo-box', [
        { user: visitor, role: 'OWNER' },
      ]);
      await db.organization.update({
        where: { id: sandbox },
        data: { isDemo: true },
      });
      const made = await http('post', `/v1/orgs/${sandbox}/clients`, {
        bearer: visitor.token,
        body: { name: 'Buyer', email: 'buyer@example.com' },
      }).expect(201);
      const invoice = await http('post', `/v1/orgs/${sandbox}/invoices`, {
        bearer: visitor.token,
        body: {
          clientId: (made.body as { id: string }).id,
          items: [{ description: 'Work', quantity: 1, unitPriceCents: 5000 }],
        },
      }).expect(201);
      await http(
        'post',
        `/v1/orgs/${sandbox}/invoices/${(invoice.body as { id: string }).id}/send`,
        { bearer: visitor.token },
      ).expect(200);

      const skipped = (await eventsOf(visitor, sandbox)).find(
        (e) => e.kind === 'email.captured',
      );
      expect(skipped?.summary).toContain('demo sandboxes never send');
      expect(skipped?.summary).toContain('Outbox');
      expect(mail.sent).toHaveLength(0);
    });

    it('shows a real email being sent AFTER the response, joined to the click that caused it', async () => {
      const made = await http('post', `/v1/orgs/${orgId}/clients`, {
        bearer: owner.token,
        body: { name: 'Buyer', email: 'buyer@example.com' },
      }).expect(201);
      const invoice = await http('post', `/v1/orgs/${orgId}/invoices`, {
        bearer: owner.token,
        body: {
          clientId: (made.body as { id: string }).id,
          items: [{ description: 'Work', quantity: 1, unitPriceCents: 5000 }],
        },
      }).expect(201);
      const sent = await http(
        'post',
        `/v1/orgs/${orgId}/invoices/${(invoice.body as { id: string }).id}/send`,
        { bearer: owner.token },
      ).expect(200);

      const events = await eventsOf(owner);
      const sendRequestId = sent.headers['x-request-id'] as string;
      const ofThatClick = events.filter((e) => e.requestId === sendRequestId);
      expect(kinds(ofThatClick)).toContain('http.request');
      expect(kinds(ofThatClick)).toContain('email.sent');
      expect(mail.sent).toHaveLength(1);
    });
  });

  describe('privacy: nothing sensitive is ever in an event', () => {
    it('contains no tokens, emails, ids, names or request bodies, only templates and plain facts', async () => {
      await http('post', `/v1/orgs/${orgId}/clients`, {
        bearer: owner.token,
        body: { name: 'Very Secret Name', email: 'secret.person@example.com' },
      }).expect(201);
      const everything = JSON.stringify(await eventsOf(owner));

      for (const forbidden of [
        owner.token,
        owner.id,
        owner.email,
        member.id,
        orgId,
        otherOrgId,
        'Very Secret Name',
        'secret.person@example.com',
        'Bearer',
      ]) {
        expect(everything).not.toContain(forbidden);
      }
      expect(everything).toContain(':orgId');
    });
  });

  describe('isolation: events only ever appear for a VERIFIED member', () => {
    it('keeps each organisation’s events to itself', async () => {
      await http('get', `/v1/orgs/${orgId}/clients`, { bearer: owner.token });
      await http('get', `/v1/orgs/${otherOrgId}/tasks`, {
        bearer: outsider.token,
      });
      const mine = await eventsOf(owner);
      const theirs = await eventsOf(outsider, otherOrgId);
      expect(mine.map((e) => e.meta.route).filter(Boolean)).toEqual([
        '/v1/orgs/:orgId/clients',
      ]);
      expect(theirs.map((e) => e.meta.route).filter(Boolean)).toEqual([
        '/v1/orgs/:orgId/tasks',
      ]);
    });

    it('answers a non-member 404, exactly as for an organisation that does not exist', async () => {
      const real = await http('get', `/v1/orgs/${orgId}/xray/events`, {
        bearer: outsider.token,
      }).expect(404);
      const ghost = await http(
        'get',
        '/v1/orgs/0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b/xray/events',
        { bearer: outsider.token },
      ).expect(404);
      const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) =>
        rest;
      expect(strip(real.body as Record<string, unknown>)).toEqual(
        strip(ghost.body as Record<string, unknown>),
      );
    });

    it('cannot be polluted: an outsider poking at someone else’s organisation leaves no trace there', async () => {
      await http('get', `/v1/orgs/${orgId}/clients`, {
        bearer: outsider.token,
      }).expect(404);
      await http('post', `/v1/orgs/${orgId}/clients`, {
        bearer: outsider.token,
        body: { name: 'Spam', email: 'spam@example.com' },
      }).expect(404);

      expect(await eventsOf(owner)).toEqual([]);
      expect(await eventsOf(outsider, otherOrgId)).toEqual([]);
      expect(await store.latest(orgId, 50)).toEqual([]);
      expect(await store.latest(otherOrgId, 50)).toEqual([]);
    });

    it('does not record requests that are not under an organisation (login, health)', async () => {
      await http('get', '/health/live').expect(200);
      await http('get', '/v1/orgs', { bearer: owner.token }).expect(200);
      expect(await eventsOf(owner)).toEqual([]);
    });
  });

  describe('who may open it', () => {
    it('lets an owner, but not a plain member of a real organisation (events show what teammates did)', async () => {
      await http('get', `/v1/orgs/${orgId}/xray/events`, {
        bearer: owner.token,
      }).expect(200);
      await http('get', `/v1/orgs/${orgId}/xray/events`, {
        bearer: member.token,
      }).expect(403);
      await http('get', `/v1/orgs/${orgId}/xray/stream`, {
        bearer: member.token,
      }).expect(403);
    });

    it('still records what the member did, for the owner to see', async () => {
      await http('get', `/v1/orgs/${orgId}/tasks`, {
        bearer: member.token,
      }).expect(200);
      const request = (await eventsOf(owner)).find(
        (e) => e.kind === 'http.request',
      );
      expect(request?.meta).toMatchObject({ route: '/v1/orgs/:orgId/tasks' });
      expect(
        (await eventsOf(owner)).find((e) => e.kind === 'tenant.check')?.meta,
      ).toEqual({ role: 'MEMBER' });
    });

    it('requires a signed-in caller', async () => {
      await http('get', `/v1/orgs/${orgId}/xray/events`).expect(401);
      await http('get', `/v1/orgs/${orgId}/xray/stream`).expect(401);
    });

    it('does not record the X-ray reading itself', async () => {
      await eventsOf(owner);
      await eventsOf(owner);
      await http('get', `/v1/orgs/${orgId}/xray/events`, {
        bearer: owner.token,
      });
      expect(await eventsOf(owner)).toEqual([]);
    });
  });

  describe('polling', () => {
    it('returns only new events when given the cursor from the last answer', async () => {
      await http('get', `/v1/orgs/${orgId}/clients`, { bearer: owner.token });
      await background.drain();
      await xray.flush();
      const first = await http('get', `/v1/orgs/${orgId}/xray/events`, {
        bearer: owner.token,
      }).expect(200);
      const { cursor } = first.body as { cursor: string };

      await http('get', `/v1/orgs/${orgId}/tasks`, { bearer: owner.token });
      await xray.flush();
      const next = await http(
        'get',
        `/v1/orgs/${orgId}/xray/events?after=${cursor}`,
        { bearer: owner.token },
      ).expect(200);
      const routes = (next.body as { data: Event[] }).data
        .map((e) => e.meta.route)
        .filter(Boolean);
      expect(routes).toEqual(['/v1/orgs/:orgId/tasks']);
    });

    it.each([
      ['after', 'not-an-id'],
      ['after', '( 0-0'],
      ['after', '1-1-1'],
      ['limit', '0'],
      ['limit', 'many'],
    ])(
      'rejects a bad %s (%s) with 400, never passing it on',
      async (key, value) => {
        await http('get', `/v1/orgs/${orgId}/xray/events?${key}=${value}`, {
          bearer: owner.token,
        }).expect(400);
      },
    );
  });
});

describe('Backend X-ray, switched off (XRAY_ENABLED=false)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let client: ReturnType<typeof createHttpClient>;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1', XRAY_ENABLED: 'false' },
    }));
    db = app.get(PrismaService);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('records nothing, and the app works exactly as before', async () => {
    await resetDb(db);
    const owner = await createAuthedUser(app, db, 'owner@example.com');
    const { id } = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
    ]);
    await client
      .call('post', `/v1/orgs/${id}/clients`, {
        bearer: owner.token,
        body: { name: 'A', email: 'a@example.com' },
      })
      .expect(201);
    await app.get(XrayService).flush();
    const res = await client
      .call('get', `/v1/orgs/${id}/xray/events`, { bearer: owner.token })
      .expect(200);
    expect(res.body).toEqual({ data: [], cursor: null });
  });
});

describe('Backend X-ray live stream (a real socket)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let xray: XrayService;
  let store: MemoryXrayStore;
  let client: ReturnType<typeof createHttpClient>;
  let owner: TestUser;
  let orgId: string;
  const open: Array<() => void> = [];

  const origin = () =>
    `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  interface Message {
    id?: string;
    type: string;
    data: unknown;
  }

  /** Opens the stream like a browser's fetch would, and collects what arrives. */
  async function connect(
    token: string,
    extraHeaders: Record<string, string> = {},
    id = orgId,
  ) {
    const controller = new AbortController();
    const response = await fetch(`${origin()}/v1/orgs/${id}/xray/stream`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'x-forwarded-for': client.freshIp(),
        ...extraHeaders,
      },
      signal: controller.signal,
    });
    const messages: Message[] = [];
    const closed = { value: false };
    const reading = (async () => {
      if (!response.body || response.status !== 200) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const field = (name: string) =>
              block
                .split('\n')
                .find((line) => line.startsWith(`${name}:`))
                ?.slice(name.length + 1)
                .trim();
            const data = field('data');
            if (data === undefined) continue;
            messages.push({
              ...(field('id') ? { id: field('id') as string } : {}),
              type: field('event') ?? 'message',
              data: JSON.parse(data) as unknown,
            });
          }
        }
      } catch {
        // aborted by the test
      } finally {
        closed.value = true;
      }
    })();
    const abort = () => controller.abort();
    open.push(abort);
    return { response, messages, closed, abort, reading };
  }

  const until = async (check: () => boolean, ms = 5000) => {
    const stop = Date.now() + ms;
    while (!check()) {
      if (Date.now() > stop) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeAll(async () => {
    ({ app } = await createTestApp({
      realDatabase: true,
      env: {
        TRUST_PROXY_HOPS: '1',
        // Far shorter than the stream lives: proves the stream is exempt from the timeout.
        REQUEST_TIMEOUT_MS: '1000',
        XRAY_HEARTBEAT_SECONDS: '1',
        XRAY_MAX_STREAMS_PER_USER: '2',
      },
    }));
    db = app.get(PrismaService);
    xray = app.get(XrayService);
    store = app.get<MemoryXrayStore>(XRAY_STORE);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    for (const abort of open) abort();
    await app.close();
  });
  beforeEach(async () => {
    for (const abort of open.splice(0)) abort();
    await resetDb(db);
    owner = await createAuthedUser(app, db, 'owner@example.com');
    ({ id: orgId } = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
    ]));
  });

  it('sends history on connect, then each new event live, then keeps the connection alive past the request timeout', async () => {
    await client
      .call('get', `/v1/orgs/${orgId}/clients`, { bearer: owner.token })
      .expect(200);
    await xray.flush();

    const stream = await connect(owner.token);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    await until(() => stream.messages.some((m) => m.type === 'xray'));
    const history = stream.messages.filter((m) => m.type === 'xray').length;
    expect(history).toBeGreaterThanOrEqual(3);

    await client
      .call('get', `/v1/orgs/${orgId}/tasks`, { bearer: owner.token })
      .expect(200);
    await until(
      () => stream.messages.filter((m) => m.type === 'xray').length > history,
    );
    const routes = stream.messages
      .filter((m) => m.type === 'xray')
      .map((m) => (m.data as Event).meta.route)
      .filter(Boolean);
    expect(routes).toEqual([
      '/v1/orgs/:orgId/clients',
      '/v1/orgs/:orgId/tasks',
    ]);

    // Longer than REQUEST_TIMEOUT_MS (1 s): still open, and heartbeats keep arriving.
    await until(
      () => stream.messages.filter((m) => m.type === 'heartbeat').length >= 2,
      6000,
    );
    expect(stream.closed.value).toBe(false);
  }, 20_000);

  it('gives every message an id, and resumes after Last-Event-ID without repeats', async () => {
    await client
      .call('get', `/v1/orgs/${orgId}/clients`, { bearer: owner.token })
      .expect(200);
    await xray.flush();
    const first = await connect(owner.token);
    await until(() => first.messages.some((m) => m.type === 'xray'));
    const seen = first.messages.filter((m) => m.type === 'xray');
    expect(seen.every((m) => typeof m.id === 'string')).toBe(true);
    const lastId = seen.at(-1)?.id as string;
    first.abort();

    await client
      .call('get', `/v1/orgs/${orgId}/tasks`, { bearer: owner.token })
      .expect(200);
    await xray.flush();
    const resumed = await connect(owner.token, { 'last-event-id': lastId });
    await until(() => resumed.messages.some((m) => m.type === 'xray'));
    const routes = resumed.messages
      .filter((m) => m.type === 'xray')
      .map((m) => (m.data as Event).meta.route)
      .filter(Boolean);
    expect(routes).toEqual(['/v1/orgs/:orgId/tasks']);
  }, 20_000);

  it('refuses a stream beyond the per-user limit with a normal error response, and frees the slot on disconnect', async () => {
    const one = await connect(owner.token);
    const two = await connect(owner.token);
    expect(one.response.status).toBe(200);
    expect(two.response.status).toBe(200);

    const three = await connect(owner.token);
    expect(three.response.status).toBe(403);
    expect(await three.response.text()).toContain('LIMIT_REACHED');

    one.abort();
    await until(() => store.listenerCount(orgId) === 1);
    const again = await connect(owner.token);
    expect(again.response.status).toBe(200);
  }, 20_000);

  it('stops listening when the client disconnects (nothing is left attached)', async () => {
    const stream = await connect(owner.token);
    await until(() => store.listenerCount(orgId) === 1);
    stream.abort();
    await until(() => store.listenerCount(orgId) === 0);
  }, 20_000);

  it('never shows one organisation’s events on another’s stream', async () => {
    const outsider = await createAuthedUser(app, db, 'outsider@example.com');
    const { id: otherId } = await createOrgWith(db, 'other', [
      { user: outsider, role: 'OWNER' },
    ]);
    const mine = await connect(owner.token);
    const theirs = await connect(outsider.token, {}, otherId);
    await until(() => store.listenerCount(orgId) === 1);

    await client
      .call('get', `/v1/orgs/${otherId}/clients`, { bearer: outsider.token })
      .expect(200);
    await xray.flush();
    await until(() => theirs.messages.some((m) => m.type === 'xray'));

    expect(mine.messages.filter((m) => m.type === 'xray')).toEqual([]);
    // And a stranger cannot attach to someone else's stream at all.
    const intruder = await connect(outsider.token, {}, orgId);
    expect(intruder.response.status).toBe(404);
  }, 20_000);
});
