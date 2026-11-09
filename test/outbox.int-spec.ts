import type { NestExpressApplication } from '@nestjs/platform-express';
import { JOB_QUEUE, type JobQueue } from '../src/core/jobs/jobs.types.js';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { XrayService } from '../src/core/xray/xray.service.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

interface Message {
  id: string;
  ts: number;
  to: string;
  subject: string;
  text: string;
}

describe('the demo Outbox (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let xray: XrayService;
  let mail: Awaited<ReturnType<typeof createTestApp>>['mail'];
  let background: Awaited<ReturnType<typeof createTestApp>>['background'];
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  /** A demo sandbox: a demo user who owns a demo organisation. */
  async function sandbox(slug: string) {
    const owner = await createAuthedUser(app, db, `${slug}@example.com`, {
      isDemo: true,
    });
    const { id } = await createOrgWith(db, slug, [
      { user: owner, role: 'OWNER' },
    ]);
    await db.organization.update({ where: { id }, data: { isDemo: true } });
    return { owner, orgId: id };
  }

  /** Creates a client and a priced draft, and sends it. Returns the send response's request id. */
  async function sendInvoice(
    actor: TestUser,
    orgId: string,
    clientName = 'Buyer',
    clientEmail = 'buyer@example.com',
  ) {
    const made = await http('post', `/v1/orgs/${orgId}/clients`, {
      bearer: actor.token,
      body: { name: clientName, email: clientEmail },
    }).expect(201);
    const invoice = await http('post', `/v1/orgs/${orgId}/invoices`, {
      bearer: actor.token,
      body: {
        clientId: (made.body as { id: string }).id,
        items: [{ description: 'Work', quantity: 2, unitPriceCents: 2500 }],
      },
    }).expect(201);
    await http(
      'post',
      `/v1/orgs/${orgId}/invoices/${(invoice.body as { id: string }).id}/send`,
      { bearer: actor.token },
    ).expect(200);
  }

  const outboxOf = async (actor: TestUser, orgId: string) => {
    await background.drain();
    await xray.flush();
    return http('get', `/v1/orgs/${orgId}/outbox`, { bearer: actor.token });
  };

  beforeAll(async () => {
    ({ app, mail, background } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1', OUTBOX_MAX_MESSAGES: '3' },
    }));
    db = app.get(PrismaService);
    xray = app.get(XrayService);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
    mail.clear();
  });

  it('captures the email a demo sandbox would have sent, shows it, and sends nothing for real', async () => {
    const { owner, orgId } = await sandbox('acme');
    await sendInvoice(
      owner,
      orgId,
      'Brightside Bakery',
      'hello@brightside.example',
    );

    const res = await outboxOf(owner, orgId);
    expect(res.status).toBe(200);
    const { data } = res.body as { data: Message[] };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      to: 'hello@brightside.example',
      subject: expect.stringMatching(/^Invoice INV-\d{4} from acme$/),
    });
    expect(data[0]?.text).toContain('Hi Brightside Bakery');
    expect(data[0]?.text).toContain('$50.00');
    expect(typeof data[0]?.id).toBe('string');
    expect(data[0]?.ts).toBeGreaterThan(0);

    // Nothing was delivered anywhere.
    expect(mail.sent).toHaveLength(0);
  });

  it('keeps the newest messages first, and only as many as OUTBOX_MAX_MESSAGES', async () => {
    const { owner, orgId } = await sandbox('acme');
    for (let n = 1; n <= 5; n++) {
      await sendInvoice(owner, orgId, `Buyer ${n}`, `buyer${n}@example.com`);
    }
    const { data } = (await outboxOf(owner, orgId)).body as { data: Message[] };
    expect(data).toHaveLength(3);
    expect(data.map((m) => m.to)).toEqual([
      'buyer5@example.com',
      'buyer4@example.com',
      'buyer3@example.com',
    ]);
  });

  it('lets every persona of the sandbox read it, including a Member', async () => {
    const { owner, orgId } = await sandbox('acme');
    const member = await createAuthedUser(app, db, 'persona@example.com', {
      isDemo: true,
    });
    await db.membership.create({
      data: { userId: member.id, organizationId: orgId, role: 'MEMBER' },
    });
    await sendInvoice(owner, orgId);
    const res = await outboxOf(member, orgId);
    expect(res.status).toBe(200);
    expect((res.body as { data: Message[] }).data).toHaveLength(1);
  });

  it('keeps visitors apart: nobody else can read it, and each sees only their own', async () => {
    const one = await sandbox('one');
    const two = await sandbox('two');
    await sendInvoice(one.owner, one.orgId, 'Only One', 'only-one@example.com');

    // Visitor two asks for visitor one's outbox with their own valid token: 404, never data.
    const stranger = await outboxOf(two.owner, one.orgId);
    expect(stranger.status).toBe(404);
    expect(JSON.stringify(stranger.body)).not.toContain('only-one@example.com');

    // And their own is empty.
    expect(
      ((await outboxOf(two.owner, two.orgId)).body as { data: Message[] }).data,
    ).toEqual([]);
  });

  it('answers a stranger exactly as it answers for an organisation that does not exist', async () => {
    const one = await sandbox('one');
    const two = await sandbox('two');
    const real = await outboxOf(two.owner, one.orgId);
    const ghost = await outboxOf(
      two.owner,
      '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b',
    );
    const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) =>
      rest;
    expect(real.status).toBe(404);
    expect(strip(real.body as Record<string, unknown>)).toEqual(
      strip(ghost.body as Record<string, unknown>),
    );
  });

  it('requires a signed-in caller', async () => {
    const { orgId } = await sandbox('acme');
    await http('get', `/v1/orgs/${orgId}/outbox`).expect(401);
  });

  it('has no outbox for a REAL organisation (its email is really delivered)', async () => {
    const owner = await createAuthedUser(app, db, 'real-owner@example.com');
    const { id: orgId } = await createOrgWith(db, 'real', [
      { user: owner, role: 'OWNER' },
    ]);
    await sendInvoice(owner, orgId, 'Real Buyer', 'real-buyer@example.com');
    await background.drain();

    // Delivered for real, through the mail transport...
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe('real-buyer@example.com');
    // ...and nothing captured: there is no outbox to look at.
    const res = await outboxOf(owner, orgId);
    expect(res.status).toBe(404);
  });

  it('returns text exactly as typed, as JSON, so the page can only ever show it as text', async () => {
    const { owner, orgId } = await sandbox('acme');
    const nasty = '<img src=x onerror=alert(1)>';
    await sendInvoice(owner, orgId, nasty, 'nasty@example.com');
    const res = await outboxOf(owner, orgId);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as { data: Message[] }).data[0]?.text).toContain(nasty);
  });

  it('never leaks the recipient into the X-ray (events carry no email addresses)', async () => {
    const { owner, orgId } = await sandbox('acme');
    await sendInvoice(owner, orgId, 'Buyer', 'private-recipient@example.com');
    await background.drain();
    await xray.flush();
    const events = await http(
      'get',
      `/v1/orgs/${orgId}/xray/events?limit=200`,
      {
        bearer: owner.token,
      },
    ).expect(200);
    const text = JSON.stringify(events.body);
    expect(text).not.toContain('private-recipient@example.com');
    expect(text).toContain('email.captured');
  });

  describe('how the invoice email is queued', () => {
    async function sendAndCaptureJob(orgKind: 'demo' | 'real') {
      const queue = app.get<JobQueue>(JOB_QUEUE);
      const add = vi.spyOn(queue, 'add');
      try {
        if (orgKind === 'demo') {
          const { owner, orgId } = await sandbox('acme');
          await sendInvoice(owner, orgId, 'Buyer', 'buyer@example.com');
          await background.drain();
          return { call: add.mock.calls.at(-1), orgId };
        }
        const owner = await createAuthedUser(app, db, 'real-owner@example.com');
        const { id: orgId } = await createOrgWith(db, 'real', [
          { user: owner, role: 'OWNER' },
        ]);
        await sendInvoice(owner, orgId, 'Buyer', 'buyer@example.com');
        await background.drain();
        return { call: add.mock.calls.at(-1), orgId };
      } finally {
        add.mockRestore();
      }
    }

    it('uses the invoice’s own id as the job id, so the same invoice is never emailed twice', async () => {
      const { call } = await sendAndCaptureJob('real');
      const [name, data, options] = call as [
        string,
        { invoiceId: string },
        { jobId: string },
      ];
      expect(name).toBe('invoice-email');
      expect(options.jobId).toBe(`invoice-email-${data.invoiceId}`);
      expect(options.jobId).not.toContain(':'); // BullMQ forbids ":" in a job id
    });

    it('asks for real delivery for a real organisation and the Outbox for a demo sandbox', async () => {
      const real = await sendAndCaptureJob('real');
      expect((real.call?.[1] as { delivery: string }).delivery).toBe('send');
      const demo = await sendAndCaptureJob('demo');
      expect((demo.call?.[1] as { delivery: string }).delivery).toBe('outbox');
    });

    it('queues only what the email needs, tied to the verified organisation, with nothing secret in it', async () => {
      const { call, orgId } = await sendAndCaptureJob('real');
      const data = call?.[1] as Record<string, unknown>;
      expect(data.organizationId).toBe(orgId);
      // Exactly the fields the handler uses (and the request id that ties it to the click):
      // anything new added here has to be added to this list on purpose.
      expect(Object.keys(data).sort()).toEqual(
        [
          'amount',
          'clientName',
          'delivery',
          'dueDate',
          'invoiceId',
          'number',
          'organizationId',
          'organizationName',
          'requestId',
          'to',
        ].sort(),
      );
      // Redis keeps queued jobs: no tokens, passwords or hashes may ever be in one.
      expect(JSON.stringify(data)).not.toMatch(
        /token|password|secret|hash|bearer/i,
      );
    });
  });
});
