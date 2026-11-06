import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

/**
 * ARCHITECTURE §21: "a dedicated suite tries to read/update org B's resources with org A's
 * credentials for every endpoint". The attacker below is the OWNER of organisation A, so
 * permissions are never the reason a request fails: only tenant isolation is.
 *
 * Organisation B holds every kind of tenant data. After each batch of attacks, B must be
 * byte-for-byte what it was before, and no response may contain any of B's secrets.
 */
describe('tenant isolation: organisation A against organisation B', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  let attacker: TestUser; // OWNER of A
  let victim: TestUser; // OWNER of B
  let victimMember: TestUser; // MEMBER of B
  let A: string;
  let B: string;
  let secret: {
    clientId: string;
    taskId: string;
    draftId: string;
    sentId: string;
    invitationId: string;
    membershipId: string;
    ownerMembershipId: string;
  };

  const MARKER = 'TOPSECRET-BETA';
  const GHOST = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

  /** Everything B owns, as one comparable string. */
  async function snapshot(): Promise<string> {
    const byId = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({
      org: await db.organization.findUnique({ where: { id: B } }),
      subscription: await db.subscription.findUnique({
        where: { organizationId: B },
      }),
      memberships: byId(
        await db.membership.findMany({ where: { organizationId: B } }),
      ),
      invitations: byId(
        await db.invitation.findMany({ where: { organizationId: B } }),
      ),
      clients: byId(await db.client.findMany({ where: { organizationId: B } })),
      tasks: byId(await db.task.findMany({ where: { organizationId: B } })),
      invoices: byId(
        await db.invoice.findMany({
          where: { organizationId: B },
          include: { lineItems: true },
        }),
      ).map((i) => ({ ...i, lineItems: byId(i.lineItems) })),
    });
  }

  beforeAll(async () => {
    ({ app } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1' },
    }));
    db = app.get(PrismaService);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(db);
    attacker = await createAuthedUser(app, db, 'attacker@example.com');
    victim = await createAuthedUser(app, db, 'victim@example.com');
    victimMember = await createAuthedUser(app, db, 'victim.member@example.com');
    const a = await createOrgWith(db, 'alpha', [
      { user: attacker, role: 'OWNER' },
    ]);
    const b = await createOrgWith(db, 'beta', [
      { user: victim, role: 'OWNER' },
      { user: victimMember, role: 'MEMBER' },
    ]);
    A = a.id;
    B = b.id;
    await db.subscription.update({
      where: { organizationId: A },
      data: { plan: 'PRO' },
    });
    await db.subscription.update({
      where: { organizationId: B },
      data: { plan: 'PRO' },
    });

    const client_ = await db.client.create({
      data: {
        organizationId: B,
        name: `${MARKER} Client`,
        email: 'secret-client@beta.example',
      },
    });
    const task = await db.task.create({
      data: {
        organizationId: B,
        title: `${MARKER} task`,
        description: 'confidential plan',
        assigneeId: b.membershipOf(victimMember),
        createdById: b.membershipOf(victim),
      },
    });
    const draft = await db.invoice.create({
      data: {
        organizationId: B,
        clientId: client_.id,
        number: 'INV-0001',
        totalCents: 123_400,
        lineItems: {
          create: {
            description: `${MARKER} work`,
            quantity: 1,
            unitPriceCents: 123_400,
          },
        },
      },
    });
    const sent = await db.invoice.create({
      data: {
        organizationId: B,
        clientId: client_.id,
        number: 'INV-0002',
        status: 'SENT',
        totalCents: 500,
        lineItems: {
          create: {
            description: 'sent work',
            quantity: 1,
            unitPriceCents: 500,
          },
        },
      },
    });
    const invitation = await db.invitation.create({
      data: {
        organizationId: B,
        email: `${MARKER.toLowerCase()}@beta.example`,
        role: 'MEMBER',
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    secret = {
      clientId: client_.id,
      taskId: task.id,
      draftId: draft.id,
      sentId: sent.id,
      invitationId: invitation.id,
      membershipId: b.membershipOf(victimMember),
      ownerMembershipId: b.membershipOf(victim),
    };
  });

  interface Attack {
    label: string;
    method: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    body?: object;
  }

  /** Runs every attack as the attacker; returns the failures instead of stopping at the first. */
  async function run(
    attacks: Attack[],
    expected: (attack: Attack) => number[],
  ) {
    const problems: string[] = [];
    for (const attack of attacks) {
      const res = await http(attack.method, attack.path, {
        bearer: attacker.token,
        body: attack.body,
      });
      const wanted = expected(attack);
      if (!wanted.includes(res.status)) {
        problems.push(
          `${attack.label}: got ${res.status}, wanted ${wanted.join('/')}`,
        );
      }
      const text = JSON.stringify(res.body);
      if (text.includes(MARKER) || text.includes('beta.example')) {
        problems.push(`${attack.label}: response leaked organisation B's data`);
      }
    }
    return problems;
  }

  // ───────── 1. B's organisation id in the URL ─────────
  const attacksViaOrgPath = (): Attack[] => {
    const o = `/v1/orgs/${B}`;
    return [
      { label: 'GET org', method: 'get', path: o },
      { label: 'PATCH org', method: 'patch', path: o, body: { name: 'pwned' } },
      { label: 'DELETE org', method: 'delete', path: o },
      { label: 'GET members', method: 'get', path: `${o}/members` },
      {
        label: 'PATCH member',
        method: 'patch',
        path: `${o}/members/${secret.membershipId}`,
        body: { role: 'OWNER' },
      },
      {
        label: 'DELETE member',
        method: 'delete',
        path: `${o}/members/${secret.membershipId}`,
      },
      { label: 'leave', method: 'post', path: `${o}/members/leave` },
      { label: 'GET invitations', method: 'get', path: `${o}/invitations` },
      {
        label: 'POST invitation',
        method: 'post',
        path: `${o}/invitations`,
        body: { email: 'x@evil.example', role: 'ADMIN' },
      },
      {
        label: 'resend invitation',
        method: 'post',
        path: `${o}/invitations/${secret.invitationId}/resend`,
      },
      {
        label: 'DELETE invitation',
        method: 'delete',
        path: `${o}/invitations/${secret.invitationId}`,
      },
      { label: 'GET clients', method: 'get', path: `${o}/clients` },
      {
        label: 'search clients',
        method: 'get',
        path: `${o}/clients?q=${MARKER}`,
      },
      {
        label: 'POST client',
        method: 'post',
        path: `${o}/clients`,
        body: { name: 'x', email: 'x@evil.example' },
      },
      {
        label: 'GET client',
        method: 'get',
        path: `${o}/clients/${secret.clientId}`,
      },
      {
        label: 'PATCH client',
        method: 'patch',
        path: `${o}/clients/${secret.clientId}`,
        body: { name: 'pwned' },
      },
      {
        label: 'DELETE client',
        method: 'delete',
        path: `${o}/clients/${secret.clientId}`,
      },
      { label: 'GET tasks', method: 'get', path: `${o}/tasks` },
      { label: 'search tasks', method: 'get', path: `${o}/tasks?q=${MARKER}` },
      {
        label: 'POST task',
        method: 'post',
        path: `${o}/tasks`,
        body: { title: 'x' },
      },
      { label: 'GET task', method: 'get', path: `${o}/tasks/${secret.taskId}` },
      {
        label: 'PATCH task',
        method: 'patch',
        path: `${o}/tasks/${secret.taskId}`,
        body: { title: 'pwned' },
      },
      {
        label: 'DELETE task',
        method: 'delete',
        path: `${o}/tasks/${secret.taskId}`,
      },
      { label: 'GET invoices', method: 'get', path: `${o}/invoices` },
      {
        label: 'POST invoice',
        method: 'post',
        path: `${o}/invoices`,
        body: { clientId: secret.clientId },
      },
      {
        label: 'GET invoice',
        method: 'get',
        path: `${o}/invoices/${secret.draftId}`,
      },
      {
        label: 'PATCH invoice',
        method: 'patch',
        path: `${o}/invoices/${secret.draftId}`,
        body: { currency: 'GBP' },
      },
      {
        label: 'DELETE invoice',
        method: 'delete',
        path: `${o}/invoices/${secret.draftId}`,
      },
      {
        label: 'send invoice',
        method: 'post',
        path: `${o}/invoices/${secret.draftId}/send`,
      },
      {
        label: 'pay invoice',
        method: 'post',
        path: `${o}/invoices/${secret.sentId}/pay`,
      },
      {
        label: 'void invoice',
        method: 'post',
        path: `${o}/invoices/${secret.sentId}/void`,
      },
      { label: 'probe', method: 'get', path: `${o}/probe/anyone` },
    ];
  };

  // ───────── 2. my own organisation in the URL, B's ids as the target ─────────
  const attacksViaForeignIds = (): Attack[] => {
    const o = `/v1/orgs/${A}`;
    return [
      {
        label: 'GET foreign client',
        method: 'get',
        path: `${o}/clients/${secret.clientId}`,
      },
      {
        label: 'PATCH foreign client',
        method: 'patch',
        path: `${o}/clients/${secret.clientId}`,
        body: { name: 'pwned' },
      },
      {
        label: 'DELETE foreign client',
        method: 'delete',
        path: `${o}/clients/${secret.clientId}`,
      },
      {
        label: 'GET foreign task',
        method: 'get',
        path: `${o}/tasks/${secret.taskId}`,
      },
      {
        label: 'PATCH foreign task',
        method: 'patch',
        path: `${o}/tasks/${secret.taskId}`,
        body: { title: 'pwned', status: 'DONE' },
      },
      {
        label: 'DELETE foreign task',
        method: 'delete',
        path: `${o}/tasks/${secret.taskId}`,
      },
      {
        label: 'GET foreign invoice',
        method: 'get',
        path: `${o}/invoices/${secret.draftId}`,
      },
      {
        label: 'PATCH foreign invoice',
        method: 'patch',
        path: `${o}/invoices/${secret.draftId}`,
        body: { currency: 'GBP', items: [] },
      },
      {
        label: 'DELETE foreign invoice',
        method: 'delete',
        path: `${o}/invoices/${secret.draftId}`,
      },
      {
        label: 'send foreign invoice',
        method: 'post',
        path: `${o}/invoices/${secret.draftId}/send`,
      },
      {
        label: 'pay foreign invoice',
        method: 'post',
        path: `${o}/invoices/${secret.sentId}/pay`,
      },
      {
        label: 'void foreign invoice',
        method: 'post',
        path: `${o}/invoices/${secret.sentId}/void`,
      },
      {
        label: 'PATCH foreign member',
        method: 'patch',
        path: `${o}/members/${secret.membershipId}`,
        body: { role: 'OWNER' },
      },
      {
        label: 'PATCH foreign owner',
        method: 'patch',
        path: `${o}/members/${secret.ownerMembershipId}`,
        body: { role: 'MEMBER' },
      },
      {
        label: 'DELETE foreign member',
        method: 'delete',
        path: `${o}/members/${secret.membershipId}`,
      },
      {
        label: 'resend foreign invitation',
        method: 'post',
        path: `${o}/invitations/${secret.invitationId}/resend`,
      },
      {
        label: 'DELETE foreign invitation',
        method: 'delete',
        path: `${o}/invitations/${secret.invitationId}`,
      },
    ];
  };

  // ───────── 3. B's ids smuggled inside the BODY of requests to my own organisation ─────────
  const attacksViaBody = (): Attack[] => {
    const o = `/v1/orgs/${A}`;
    return [
      {
        label: 'invoice for a foreign client',
        method: 'post',
        path: `${o}/invoices`,
        body: { clientId: secret.clientId },
      },
      {
        label: 'task assigned to a foreign member',
        method: 'post',
        path: `${o}/tasks`,
        body: { title: 'x', assigneeId: secret.membershipId },
      },
      {
        label: 'task assigned to a foreign owner',
        method: 'post',
        path: `${o}/tasks`,
        body: { title: 'x', assigneeId: secret.ownerMembershipId },
      },
      {
        label: 'organizationId in a client body',
        method: 'post',
        path: `${o}/clients`,
        body: { name: 'x', email: 'x@a.example', organizationId: B },
      },
      {
        label: 'organizationId in a task body',
        method: 'post',
        path: `${o}/tasks`,
        body: { title: 'x', organizationId: B },
      },
      {
        label: 'organizationId in an invoice body',
        method: 'post',
        path: `${o}/invoices`,
        body: { clientId: GHOST, organizationId: B },
      },
    ];
  };

  it('every endpoint, aimed at B by URL: 404, nothing leaked, nothing changed', async () => {
    const before = await snapshot();
    expect(await run(attacksViaOrgPath(), () => [404])).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('every endpoint, aimed at B’s records by id from my own organisation: 404, nothing changed', async () => {
    const before = await snapshot();
    expect(await run(attacksViaForeignIds(), () => [404])).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('B’s ids smuggled in request bodies are refused (400), and nothing is created anywhere', async () => {
    const before = await snapshot();
    const problems = await run(attacksViaBody(), () => [400]);
    expect(problems).toEqual([]);
    expect(await snapshot()).toBe(before);
    // Nothing was created in A either (a refused request must not leave half a record).
    expect(await db.invoice.count({ where: { organizationId: A } })).toBe(0);
    expect(await db.task.count({ where: { organizationId: A } })).toBe(0);
    expect(await db.client.count({ where: { organizationId: A } })).toBe(0);
  });

  it('smuggling B’s ids into an UPDATE of my own records is refused and changes nothing', async () => {
    const mine = {
      client: await db.client.create({
        data: { organizationId: A, name: 'Mine', email: 'mine@a.example' },
      }),
      task: await db.task.create({
        data: { organizationId: A, title: 'mine' },
      }),
    };
    const invoice = (
      await http('post', `/v1/orgs/${A}/invoices`, {
        bearer: attacker.token,
        body: {
          clientId: mine.client.id,
          items: [{ description: 'x', quantity: 1, unitPriceCents: 5 }],
        },
      }).expect(201)
    ).body;
    const before = await snapshot();

    await http('patch', `/v1/orgs/${A}/invoices/${invoice.id}`, {
      bearer: attacker.token,
      body: { clientId: secret.clientId },
    }).expect(400);
    await http('patch', `/v1/orgs/${A}/tasks/${mine.task.id}`, {
      bearer: attacker.token,
      body: { assigneeId: secret.membershipId },
    }).expect(400);

    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .clientId,
    ).toBe(mine.client.id);
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: mine.task.id } }))
        .assigneeId,
    ).toBeNull();
    expect(await snapshot()).toBe(before);
  });

  it('no list endpoint of my organisation ever contains B’s data, searched or not', async () => {
    // Give A some data too, so the lists are not trivially empty.
    await db.client.create({
      data: {
        organizationId: A,
        name: 'Alpha Client',
        email: 'a@alpha.example',
      },
    });
    await db.task.create({ data: { organizationId: A, title: 'alpha task' } });
    const o = `/v1/orgs/${A}`;
    const paths = [
      `${o}/clients`,
      `${o}/clients?q=${MARKER}`,
      `${o}/clients?q=beta`,
      `${o}/tasks`,
      `${o}/tasks?q=${MARKER}`,
      `${o}/tasks?q=confidential`,
      `${o}/tasks?assigneeId=${secret.membershipId}`,
      `${o}/invoices`,
      `${o}/invoices?q=0001`,
      `${o}/invoices?clientId=${secret.clientId}`,
      `${o}/members`,
      `${o}/invitations`,
      `${o}`,
      '/v1/orgs',
      '/v1/auth/me',
    ];
    for (const path of paths) {
      const res = await http('get', path, { bearer: attacker.token });
      expect([200, 400], path).toContain(res.status);
      const text = JSON.stringify(res.body);
      expect(text, path).not.toContain(MARKER);
      expect(text, path).not.toContain('beta.example');
      expect(text, path).not.toContain('victim');
      expect(text, path).not.toContain(B);
    }
  });

  it('a cursor taken from B’s list cannot be used to read B’s rows from A', async () => {
    // B has two clients so its first page has a next cursor.
    await db.client.create({
      data: {
        organizationId: B,
        name: `${MARKER} 2`,
        email: 'two@beta.example',
      },
    });
    const theirs = await http('get', `/v1/orgs/${B}/clients?limit=1`, {
      bearer: victim.token,
    }).expect(200);
    expect(theirs.body.nextCursor).toBeTruthy();
    await db.client.create({
      data: { organizationId: A, name: 'Zed', email: 'zed@alpha.example' },
    });
    const res = await http(
      'get',
      `/v1/orgs/${A}/clients?cursor=${theirs.body.nextCursor}`,
      {
        bearer: attacker.token,
      },
    ).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
  });

  describe('a person who belongs to BOTH organisations only has their own role in each', () => {
    it('OWNER of A and MEMBER of B can read B but never use owner or admin powers there', async () => {
      await db.membership.create({
        data: { userId: attacker.id, organizationId: B, role: 'MEMBER' },
      });
      const before = await snapshot();
      const o = `/v1/orgs/${B}`;

      // What a MEMBER may do.
      await http('get', `${o}/tasks`, { bearer: attacker.token }).expect(200);
      await http('get', `${o}/invoices`, { bearer: attacker.token }).expect(
        200,
      );
      await http('post', `${o}/tasks`, {
        bearer: attacker.token,
        body: { title: 'allowed' },
      }).expect(201);
      const after = await snapshot();
      expect(after).not.toBe(before); // the one task created above

      // What only an owner or admin may do: all refused with 403, using A's OWNER status.
      const forbidden: Attack[] = [
        { label: 'rename', method: 'patch', path: o, body: { name: 'pwned' } },
        { label: 'delete org', method: 'delete', path: o },
        {
          label: 'change role',
          method: 'patch',
          path: `${o}/members/${secret.membershipId}`,
          body: { role: 'OWNER' },
        },
        {
          label: 'remove member',
          method: 'delete',
          path: `${o}/members/${secret.ownerMembershipId}`,
        },
        {
          label: 'invite',
          method: 'post',
          path: `${o}/invitations`,
          body: { email: 'x@evil.example', role: 'ADMIN' },
        },
        { label: 'list invitations', method: 'get', path: `${o}/invitations` },
        {
          label: 'create client',
          method: 'post',
          path: `${o}/clients`,
          body: { name: 'x', email: 'x@evil.example' },
        },
        {
          label: 'delete client',
          method: 'delete',
          path: `${o}/clients/${secret.clientId}`,
        },
        {
          label: 'create invoice',
          method: 'post',
          path: `${o}/invoices`,
          body: { clientId: secret.clientId },
        },
        {
          label: 'send invoice',
          method: 'post',
          path: `${o}/invoices/${secret.draftId}/send`,
        },
        {
          label: 'void invoice',
          method: 'post',
          path: `${o}/invoices/${secret.sentId}/void`,
        },
        // A member cannot edit or delete tasks they did not create or are not assigned.
        {
          label: 'edit others’ task',
          method: 'patch',
          path: `${o}/tasks/${secret.taskId}`,
          body: { title: 'pwned' },
        },
        {
          label: 'delete others’ task',
          method: 'delete',
          path: `${o}/tasks/${secret.taskId}`,
        },
      ];
      const mid = await snapshot();
      expect(await run(forbidden, () => [403])).toEqual([]);
      expect(await snapshot()).toBe(mid);
    });
  });

  it('losing membership in B cuts access at once, even with a valid token', async () => {
    const m = await db.membership.create({
      data: { userId: attacker.id, organizationId: B, role: 'ADMIN' },
    });
    await http('get', `/v1/orgs/${B}/tasks`, { bearer: attacker.token }).expect(
      200,
    );
    await db.membership.delete({ where: { id: m.id } });
    expect(await run(attacksViaOrgPath(), () => [404])).toEqual([]);
  });

  it('the same checks hold for an unauthenticated caller (401) and a garbage token (401)', async () => {
    const before = await snapshot();
    for (const attack of attacksViaOrgPath()) {
      const anon = await http(attack.method, attack.path, {
        body: attack.body,
      });
      expect(anon.status, `anonymous ${attack.label}`).toBe(401);
      const bad = await http(attack.method, attack.path, {
        bearer: 'not.a.token',
        body: attack.body,
      });
      expect(bad.status, `bad token ${attack.label}`).toBe(401);
    }
    expect(await snapshot()).toBe(before);
  });
});
