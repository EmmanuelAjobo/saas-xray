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

const GHOST = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) => rest;

describe('tasks (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser; // "me" in the member-rule tests
  let colleague: TestUser; // another plain member
  let outsider: TestUser;
  let orgId: string;
  let otherOrgId: string;
  let mid: (user: TestUser) => string;
  let outsiderMid: string;
  const base = () => `/v1/orgs/${orgId}/tasks`;

  const create = (actor: TestUser, body: object) =>
    http('post', base(), { bearer: actor.token, body });
  const patch = (actor: TestUser, id: string, body: object) =>
    http('patch', `${base()}/${id}`, { bearer: actor.token, body });
  const del = (actor: TestUser, id: string) =>
    http('delete', `${base()}/${id}`, { bearer: actor.token });
  /** A task row created directly (so the creator/assignee are exactly what a test needs). */
  const seed = (data: {
    title?: string;
    createdBy?: TestUser;
    assignee?: TestUser;
    createdAt?: Date;
  }) =>
    db.task.create({
      data: {
        organizationId: orgId,
        title: data.title ?? 'seeded',
        createdById: data.createdBy ? mid(data.createdBy) : null,
        assigneeId: data.assignee ? mid(data.assignee) : null,
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });

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
    owner = await createAuthedUser(app, db, 'owner@example.com');
    admin = await createAuthedUser(app, db, 'admin@example.com');
    member = await createAuthedUser(app, db, 'member@example.com');
    colleague = await createAuthedUser(app, db, 'colleague@example.com');
    outsider = await createAuthedUser(app, db, 'outsider@example.com');
    const org = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
      { user: admin, role: 'ADMIN' },
      { user: member, role: 'MEMBER' },
      { user: colleague, role: 'MEMBER' },
    ]);
    orgId = org.id;
    mid = org.membershipOf;
    const other = await createOrgWith(db, 'other', [
      { user: outsider, role: 'OWNER' },
    ]);
    otherOrgId = other.id;
    outsiderMid = other.membershipOf(outsider);
  });

  describe('creating', () => {
    it('any member can create; defaults apply; the creator is recorded', async () => {
      const res = await create(member, { title: '  Write docs  ' }).expect(201);
      expect(res.body).toMatchObject({
        title: 'Write docs',
        description: null,
        status: 'TODO',
        priority: 'MEDIUM',
        assignee: null,
        dueDate: null,
        createdById: mid(member),
      });
      expect(res.body).not.toHaveProperty('organizationId');
      expect(res.body).not.toHaveProperty('deletedAt');
    });

    it('accepts every field, including an assignee (with their name) and a due date', async () => {
      const res = await create(owner, {
        title: 'Full',
        description: 'details',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        assigneeId: mid(colleague),
        dueDate: '2026-12-31T17:00:00Z',
      }).expect(201);
      expect(res.body).toMatchObject({
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        assignee: { id: mid(colleague), name: 'colleague' },
        dueDate: '2026-12-31T17:00:00.000Z',
      });
    });

    it('refuses to assign to someone outside the organisation, naming the field (400)', async () => {
      for (const assigneeId of [outsiderMid, GHOST]) {
        const res = await create(owner, { title: 'x', assigneeId }).expect(400);
        expect(res.body.errors).toEqual([
          {
            field: 'assigneeId',
            message: 'must be a member of this organization',
          },
        ]);
      }
      expect(await db.task.count()).toBe(0);
    });

    it.each([
      ['an empty title', { title: '' }],
      ['a blank title', { title: '   ' }],
      ['a title over 200 characters', { title: 'x'.repeat(201) }],
      ['a missing title', {}],
      ['an unknown status', { title: 'x', status: 'DOING' }],
      ['an unknown priority', { title: 'x', priority: 'URGENT' }],
      ['a malformed assignee id', { title: 'x', assigneeId: 'abc' }],
      ['a malformed date', { title: 'x', dueDate: 'tomorrow' }],
      ['organizationId in the body', { title: 'x', organizationId: GHOST }],
      ['createdById in the body', { title: 'x', createdById: GHOST }],
      [
        'deletedAt in the body',
        { title: 'x', deletedAt: '2026-01-01T00:00:00Z' },
      ],
    ])('rejects %s with 400 and creates nothing', async (_label, body) => {
      await create(owner, body).expect(400);
      expect(await db.task.count()).toBe(0);
    });

    it('rejects outsiders (404) and anonymous callers (401)', async () => {
      await create(outsider, { title: 'x' }).expect(404);
      await http('post', base(), { body: { title: 'x' } }).expect(401);
    });
  });

  describe('listing', () => {
    it('shows newest first, with assignee names, and hides deleted tasks', async () => {
      const t0 = Date.now();
      const old = await seed({
        title: 'old',
        createdAt: new Date(t0 - 3000),
        assignee: member,
      });
      await seed({ title: 'mid', createdAt: new Date(t0 - 2000) });
      const gone = await seed({
        title: 'gone',
        createdAt: new Date(t0 - 1000),
      });
      await db.task.update({
        where: { id: gone.id },
        data: { deletedAt: new Date() },
      });
      await seed({ title: 'new', createdAt: new Date(t0) });

      const res = await http('get', base(), { bearer: member.token }).expect(
        200,
      );
      expect(res.body.data.map((t: { title: string }) => t.title)).toEqual([
        'new',
        'mid',
        'old',
      ]);
      const oldView = res.body.data.find(
        (t: { id: string }) => t.id === old.id,
      );
      expect(oldView.assignee).toEqual({ id: mid(member), name: 'member' });
    });

    it('filters by status, priority, assignee (including "me") and search text', async () => {
      await db.task.createMany({
        data: [
          {
            organizationId: orgId,
            title: 'Alpha report',
            status: 'TODO',
            priority: 'HIGH',
            assigneeId: mid(member),
          },
          {
            organizationId: orgId,
            title: 'Beta report',
            status: 'DONE',
            priority: 'LOW',
            assigneeId: mid(colleague),
          },
          {
            organizationId: orgId,
            title: 'Gamma',
            description: 'about the REPORT',
            status: 'TODO',
            priority: 'LOW',
          },
          { organizationId: orgId, title: '100% done_ish', status: 'TODO' },
        ],
      });
      const titles = async (query: string, actor = member) =>
        (
          await http('get', `${base()}?${query}`, {
            bearer: actor.token,
          }).expect(200)
        ).body.data
          .map((t: { title: string }) => t.title)
          .sort();

      expect(await titles('status=TODO')).toEqual([
        '100% done_ish',
        'Alpha report',
        'Gamma',
      ]);
      expect(await titles('priority=LOW')).toEqual(['Beta report', 'Gamma']);
      expect(await titles('assigneeId=me')).toEqual(['Alpha report']);
      expect(await titles('assigneeId=me', colleague)).toEqual(['Beta report']);
      expect(await titles(`assigneeId=${mid(colleague)}`)).toEqual([
        'Beta report',
      ]);
      expect(await titles('q=report')).toEqual([
        'Alpha report',
        'Beta report',
        'Gamma',
      ]);
      expect(await titles('status=TODO&priority=LOW&q=report')).toEqual([
        'Gamma',
      ]);
      expect(await titles('q=%25')).toEqual(['100% done_ish']); // "%" is literal
      expect(await titles('q=_')).toEqual(['100% done_ish']); // only the literal underscore
      // A malformed id is a clean 400, never a 500.
      const bad = await http('get', `${base()}?assigneeId=not-an-id`, {
        bearer: member.token,
      }).expect(400);
      expect(bad.body.errors[0].field).toBe('assigneeId');
      await http('get', `${base()}?status=NOPE`, {
        bearer: member.token,
      }).expect(400);
    });

    it('pages through everything exactly once, newest first', async () => {
      const t0 = Date.now();
      for (let i = 0; i < 23; i++) {
        await seed({
          title: `t${String(i).padStart(2, '0')}`,
          createdAt: new Date(t0 + i),
        });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: {
          body: { data: Array<{ title: string }>; nextCursor: string | null };
        } = await http(
          'get',
          `${base()}?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
          {
            bearer: owner.token,
          },
        ).expect(200);
        seen.push(...res.body.data.map((t) => t.title));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      expect(seen[0]).toBe('t22');
      expect(seen[22]).toBe('t00');
    });

    it('pages correctly when many tasks share the exact same timestamp (the id breaks ties)', async () => {
      const same = new Date();
      for (let i = 0; i < 12; i++)
        await seed({ title: `same${i}`, createdAt: same });
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const res: {
          body: { data: Array<{ id: string }>; nextCursor: string | null };
        } = await http(
          'get',
          `${base()}?limit=5${cursor ? `&cursor=${cursor}` : ''}`,
          { bearer: owner.token },
        ).expect(200);
        seen.push(...res.body.data.map((t) => t.id));
        cursor = res.body.nextCursor;
      } while (cursor && ++guard < 10);
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });

    it('rejects a cursor that decodes but is nonsense for this list (400, not 500)', async () => {
      const fake = Buffer.from(JSON.stringify(['not-a-date', GHOST])).toString(
        'base64url',
      );
      const res = await http('get', `${base()}?cursor=${fake}`, {
        bearer: owner.token,
      }).expect(400);
      expect(res.body.errors).toEqual([
        { field: 'cursor', message: 'is not a valid cursor' },
      ]);
    });

    it('never shows another organisation’s tasks', async () => {
      await db.task.create({
        data: { organizationId: otherOrgId, title: 'secret' },
      });
      await seed({ title: 'mine' });
      const res = await http('get', base(), { bearer: owner.token }).expect(
        200,
      );
      expect(res.body.data.map((t: { title: string }) => t.title)).toEqual([
        'mine',
      ]);
      const q = await http('get', `${base()}?q=secret`, {
        bearer: owner.token,
      }).expect(200);
      expect(q.body.data).toEqual([]);
    });
  });

  describe('reading one', () => {
    it('returns it; a foreign, unknown, malformed or deleted id is the same 404', async () => {
      const mine = await seed({ title: 'mine' });
      const theirs = await db.task.create({
        data: { organizationId: otherOrgId, title: 'theirs' },
      });
      const deleted = await seed({ title: 'deleted' });
      await db.task.update({
        where: { id: deleted.id },
        data: { deletedAt: new Date() },
      });

      await http('get', `${base()}/${mine.id}`, {
        bearer: member.token,
      }).expect(200);
      const bodies = [];
      for (const id of [theirs.id, GHOST, 'not-a-uuid', deleted.id]) {
        const res = await http('get', `${base()}/${id}`, {
          bearer: owner.token,
        }).expect(404);
        bodies.push(JSON.stringify(strip(res.body)));
      }
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe('editing', () => {
    it('lets owners and admins edit any task, partially, including clearing fields', async () => {
      const task = await seed({ title: 'orig', assignee: member });
      const res = await patch(admin, task.id, {
        title: 'new title',
        status: 'DONE',
        assigneeId: null,
        dueDate: '2027-01-01T00:00:00Z',
      }).expect(200);
      expect(res.body).toMatchObject({
        title: 'new title',
        status: 'DONE',
        assignee: null,
        priority: 'MEDIUM',
      });
      const cleared = await patch(owner, task.id, { dueDate: null }).expect(
        200,
      );
      expect(cleared.body.dueDate).toBeNull();
    });

    it('lets a member edit a task they CREATED', async () => {
      const task = await seed({ createdBy: member });
      await patch(member, task.id, {
        title: 'mine, edited',
        status: 'IN_PROGRESS',
      }).expect(200);
    });

    it('lets a member edit a task ASSIGNED to them (but not hand it to someone else)', async () => {
      const task = await seed({ createdBy: colleague, assignee: member });
      await patch(member, task.id, {
        status: 'DONE',
        description: 'finished',
      }).expect(200);
      const res = await patch(member, task.id, {
        assigneeId: mid(colleague),
      }).expect(403);
      expect(res.body.detail).toMatch(/created a task can reassign/);
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: task.id } }))
          .assigneeId,
      ).toBe(mid(member));
    });

    it('lets the creator reassign their own task', async () => {
      const task = await seed({ createdBy: member });
      await patch(member, task.id, { assigneeId: mid(colleague) }).expect(200);
    });

    it('stops a member editing someone else’s task (403) and changes nothing', async () => {
      const task = await seed({
        title: 'not yours',
        createdBy: colleague,
        assignee: colleague,
      });
      const res = await patch(member, task.id, { title: 'hacked' }).expect(403);
      expect(res.body.detail).toMatch(/created or are assigned/);
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: task.id } })).title,
      ).toBe('not yours');
    });

    it('treats a task nobody created (e.g. seeded) as not editable by members', async () => {
      const task = await seed({});
      await patch(member, task.id, { title: 'x' }).expect(403);
      await patch(admin, task.id, { title: 'x' }).expect(200);
    });

    it('validates the new assignee and refuses fields that cannot be changed', async () => {
      const task = await seed({ createdBy: member });
      const res = await patch(owner, task.id, {
        assigneeId: outsiderMid,
      }).expect(400);
      expect(res.body.errors[0].field).toBe('assigneeId');
      for (const body of [
        { organizationId: otherOrgId },
        { createdById: mid(owner) },
        { deletedAt: null },
        { id: GHOST },
        { status: 'NOPE' },
        { title: '' },
      ]) {
        await patch(owner, task.id, body).expect(400);
      }
    });

    it('answers 404 for a foreign, deleted or unknown task, and to outsiders', async () => {
      const theirs = await db.task.create({
        data: { organizationId: otherOrgId, title: 'theirs' },
      });
      const gone = await seed({});
      await db.task.update({
        where: { id: gone.id },
        data: { deletedAt: new Date() },
      });
      await patch(owner, theirs.id, { title: 'x' }).expect(404);
      await patch(owner, gone.id, { title: 'x' }).expect(404);
      await patch(owner, GHOST, { title: 'x' }).expect(404);
      await patch(outsider, gone.id, { title: 'x' }).expect(404);
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: theirs.id } })).title,
      ).toBe('theirs');
    });
  });

  describe('deleting', () => {
    it('soft-deletes: gone from every view, but the row remains', async () => {
      const task = await seed({ createdBy: member });
      await del(member, task.id).expect(204);
      await http('get', `${base()}/${task.id}`, { bearer: owner.token }).expect(
        404,
      );
      const list = await http('get', base(), { bearer: owner.token }).expect(
        200,
      );
      expect(list.body.data).toEqual([]);
      const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(row.deletedAt).not.toBeNull();
      await del(owner, task.id).expect(404); // already deleted
    });

    it('lets owners and admins delete any task; members only their own creations', async () => {
      const mine = await seed({ createdBy: member });
      const assignedOnly = await seed({
        createdBy: colleague,
        assignee: member,
      });
      const theirs = await seed({ createdBy: colleague });
      const res = await del(member, assignedOnly.id).expect(403);
      expect(res.body.detail).toMatch(/created/);
      await del(member, theirs.id).expect(403);
      await del(member, mine.id).expect(204);
      await del(admin, assignedOnly.id).expect(204);
      await del(owner, theirs.id).expect(204);
    });

    it('cannot delete a foreign task', async () => {
      const theirs = await db.task.create({
        data: { organizationId: otherOrgId, title: 'theirs' },
      });
      await del(owner, theirs.id).expect(404);
      await del(outsider, theirs.id).expect(404); // outsider is in the OTHER org, but this URL is acme's
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: theirs.id } }))
          .deletedAt,
      ).toBeNull();
    });
  });

  describe('when people leave', () => {
    it('removing a member keeps their tasks, unassigned and with no creator', async () => {
      const task = await seed({
        createdBy: member,
        assignee: member,
        title: 'orphan',
      });
      await db.membership.delete({
        where: {
          userId_organizationId: { userId: member.id, organizationId: orgId },
        },
      });
      const res = await http('get', `${base()}/${task.id}`, {
        bearer: owner.token,
      }).expect(200);
      expect(res.body).toMatchObject({
        title: 'orphan',
        assignee: null,
        createdById: null,
      });
    });
  });
});
