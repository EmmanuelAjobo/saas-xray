import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TenantViolationError } from './tenant-errors.js';
import {
  MODEL_SCOPES,
  TENANT_REFERENCES,
  type ScopedModel,
  collectReferences,
  scopeArgs,
} from './tenant-scope.js';

const T = '0198a2b4-5d6e-7f80-9a1b-000000000001';
const OTHER = '0198a2b4-5d6e-7f80-9a1b-000000000002';
const ID = '0198a2b4-5d6e-7f80-9a1b-0000000000aa';

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const scope = (model: ScopedModel, operation: string, args?: unknown) =>
  scopeArgs(model, operation, args, T) as Args;

describe('scopeArgs: reads and filters get the tenant ANDed in', () => {
  it.each([
    'findMany',
    'findFirst',
    'findFirstOrThrow',
    'count',
    'aggregate',
    'groupBy',
    'updateMany',
    'deleteMany',
  ])('%s with no filter becomes a tenant filter', (operation) => {
    expect(scope('Task', operation, {}).where).toEqual({
      AND: [{ organizationId: T }],
    });
    expect(scope('Task', operation, undefined).where).toEqual({
      AND: [{ organizationId: T }],
    });
  });

  it('keeps the caller’s own filter alongside the tenant condition', () => {
    const out = scope('Task', 'findMany', {
      where: { status: 'TODO' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(out).toEqual({
      where: { status: 'TODO', AND: [{ organizationId: T }] },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  });

  it('puts the tenant condition FIRST and preserves an existing AND (object or array)', () => {
    expect(
      scope('Task', 'findMany', { where: { AND: { status: 'DONE' } } }).where
        .AND,
    ).toEqual([{ organizationId: T }, { status: 'DONE' }]);
    expect(
      scope('Task', 'findMany', { where: { AND: [{ a: 1 }, { b: 2 }] } }).where
        .AND,
    ).toEqual([{ organizationId: T }, { a: 1 }, { b: 2 }]);
  });

  it('a caller asking for ANOTHER organisation just gets the intersection (nothing)', () => {
    const out = scope('Task', 'findMany', { where: { organizationId: OTHER } });
    expect(out.where).toEqual({
      organizationId: OTHER,
      AND: [{ organizationId: T }],
    });
  });

  it('an OR cannot widen the query beyond the tenant', () => {
    const out = scope('Task', 'findMany', {
      where: { OR: [{ organizationId: OTHER }, { title: 'x' }] },
    });
    // The tenant condition sits at the top level, ANDed with the whole OR.
    expect(out.where.AND[0]).toEqual({ organizationId: T });
    expect(out.where.OR).toHaveLength(2);
  });

  it.each(['findUnique', 'findUniqueOrThrow', 'update', 'delete'])(
    '%s by id also requires the tenant',
    (operation) => {
      const out = scope('Invoice', operation, { where: { id: ID }, data: {} });
      expect(out.where).toEqual({ id: ID, AND: [{ organizationId: T }] });
    },
  );

  it('never mutates the object it was given', () => {
    const input = { where: { id: ID } };
    scopeArgs('Task', 'findUnique', input, T);
    expect(input).toEqual({ where: { id: ID } });
  });
});

describe('scopeArgs: writes', () => {
  it('create forces organizationId', () => {
    expect(scope('Task', 'create', { data: { title: 'x' } }).data).toEqual({
      title: 'x',
      organizationId: T,
    });
  });

  it('create refuses a different organisationId instead of silently rewriting it', () => {
    expect(() =>
      scope('Task', 'create', { data: { title: 'x', organizationId: OTHER } }),
    ).toThrow(TenantViolationError);
  });

  it('create accepts the SAME organisationId', () => {
    expect(
      scope('Task', 'create', { data: { title: 'x', organizationId: T } }).data,
    ).toEqual({ title: 'x', organizationId: T });
  });

  it.each(['Task', 'Client', 'Invoice', 'Membership'] as const)(
    '%s: the relation form `organization: { connect }` is refused',
    (model) => {
      expect(() =>
        scope(model, 'create', {
          data: { organization: { connect: { id: OTHER } } },
        }),
      ).toThrow(/relation form/);
    },
  );

  it('createMany scopes every row, and refuses if any row names another tenant', () => {
    const out = scope('Task', 'createMany', {
      data: [{ title: 'a' }, { title: 'b' }],
    });
    expect(out.data).toEqual([
      { title: 'a', organizationId: T },
      { title: 'b', organizationId: T },
    ]);
    expect(() =>
      scope('Task', 'createMany', {
        data: [{ title: 'a' }, { title: 'b', organizationId: OTHER }],
      }),
    ).toThrow(TenantViolationError);
  });

  it('update and updateMany cannot move a row to another tenant', () => {
    for (const operation of ['update', 'updateMany']) {
      expect(() =>
        scope('Task', operation, {
          where: { id: ID },
          data: { organizationId: OTHER },
        }),
      ).toThrow(TenantViolationError);
    }
    // Leaving it untouched, or "re-stating" the same tenant, is fine.
    expect(
      scope('Task', 'update', { where: { id: ID }, data: { title: 'new' } })
        .data,
    ).toEqual({ title: 'new' });
  });

  it('upsert scopes the lookup, the create and checks the update', () => {
    const out = scope('Client', 'upsert', {
      where: { id: ID },
      create: { name: 'c' },
      update: { name: 'd' },
    });
    expect(out.where).toEqual({ id: ID, AND: [{ organizationId: T }] });
    expect(out.create).toEqual({ name: 'c', organizationId: T });
    expect(out.update).toEqual({ name: 'd' });
    expect(() =>
      scope('Client', 'upsert', {
        where: { id: ID },
        create: { name: 'c' },
        update: { organizationId: OTHER },
      }),
    ).toThrow(TenantViolationError);
  });

  it('fails closed on an operation it does not know', () => {
    for (const operation of ['findRaw', 'aggregateRaw', 'somethingNew', '']) {
      expect(() => scope('Task', operation, {})).toThrow(/not supported/);
    }
  });
});

describe('scopeArgs: the Organization itself', () => {
  it('is addressed by id: reads and updates only reach the current organisation', () => {
    expect(scope('Organization', 'findMany', {}).where).toEqual({
      AND: [{ id: T }],
    });
    expect(
      scope('Organization', 'update', { where: { id: OTHER }, data: {} }).where,
    ).toEqual({
      id: OTHER,
      AND: [{ id: T }],
    });
  });

  it('cannot be created or upserted through the tenant client', () => {
    for (const operation of ['create', 'createMany', 'upsert']) {
      expect(() =>
        scope('Organization', operation, { data: {}, create: {}, update: {} }),
      ).toThrow(TenantViolationError);
    }
  });

  it('its id cannot be changed', () => {
    expect(() =>
      scope('Organization', 'update', {
        where: { id: T },
        data: { id: OTHER },
      }),
    ).toThrow(/id cannot be changed/);
  });
});

describe('scopeArgs: invoice line items (no organizationId of their own)', () => {
  it('are reached only through an invoice of the current tenant', () => {
    expect(
      scope('InvoiceLineItem', 'findMany', { where: { invoiceId: ID } }).where,
    ).toEqual({
      invoiceId: ID,
      AND: [{ invoice: { organizationId: T } }],
    });
    expect(
      scope('InvoiceLineItem', 'delete', { where: { id: ID } }).where,
    ).toEqual({
      id: ID,
      AND: [{ invoice: { organizationId: T } }],
    });
  });

  it('cannot be attached to an invoice with the relation form', () => {
    expect(() =>
      scope('InvoiceLineItem', 'create', {
        data: {
          invoice: { connect: { id: ID } },
          description: 'x',
          quantity: 1,
          unitPriceCents: 1,
        },
      }),
    ).toThrow(/relation form/);
  });
});

describe('scopeArgs: global models are off limits', () => {
  it.each([
    'User',
    'OAuthAccount',
    'RefreshToken',
    'AuthToken',
    'StripeEvent',
  ] as const)('%s', (model) => {
    for (const operation of [
      'findMany',
      'findUnique',
      'create',
      'update',
      'delete',
    ]) {
      expect(() => scope(model, operation, { where: {}, data: {} })).toThrow(
        /not tenant data/,
      );
    }
  });
});

describe('collectReferences (foreign keys that must stay inside the tenant)', () => {
  it('finds scalar references on create', () => {
    expect(
      collectReferences('Invoice', 'create', {
        data: { clientId: 'c1', pdfFileId: 'f1', number: 'INV-1' },
      }),
    ).toEqual([
      { field: 'clientId', model: 'Client', id: 'c1' },
      { field: 'pdfFileId', model: 'FileObject', id: 'f1' },
    ]);
  });

  it('understands Prisma’s `{ set }` update form, and ignores null and undefined', () => {
    expect(
      collectReferences('Task', 'update', {
        where: { id: 't' },
        data: { assigneeId: { set: 'm1' }, createdById: null },
      }),
    ).toEqual([{ field: 'assigneeId', model: 'Membership', id: 'm1' }]);
    expect(
      collectReferences('Task', 'update', { data: { title: 'x' } }),
    ).toEqual([]);
  });

  it('covers createMany rows and both sides of an upsert, without duplicates', () => {
    expect(
      collectReferences('Task', 'createMany', {
        data: [
          { assigneeId: 'm1' },
          { assigneeId: 'm1' },
          { assigneeId: 'm2' },
        ],
      }),
    ).toHaveLength(2);
    expect(
      collectReferences('Task', 'upsert', {
        create: { assigneeId: 'm1' },
        update: { assigneeId: 'm2' },
      }),
    ).toHaveLength(2);
  });

  it('reads and deletes reference nothing; models without references return nothing', () => {
    expect(
      collectReferences('Task', 'findMany', { where: { assigneeId: 'm1' } }),
    ).toEqual([]);
    expect(collectReferences('Task', 'delete', { where: { id: 't' } })).toEqual(
      [],
    );
    expect(
      collectReferences('Client', 'create', { data: { name: 'x' } }),
    ).toEqual([]);
  });
});

// ─────────────────────────── the schema is fully classified ───────────────────────────

interface SchemaModel {
  fields: Map<string, string>; // field name → type
  relations: Array<{ type: string; fields: string[] }>;
}

function parseSchema(): Map<string, SchemaModel> {
  const source = readFileSync(
    join(process.cwd(), 'prisma/schema.prisma'),
    'utf8',
  );
  const models = new Map<string, SchemaModel>();
  for (const match of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match as unknown as [string, string, string];
    const model: SchemaModel = { fields: new Map(), relations: [] };
    for (const line of body.split('\n')) {
      const field = /^\s{2}(\w+)\s+(\w+)(\?|\[\])?/.exec(line);
      if (
        !field ||
        line.trim().startsWith('//') ||
        line.trim().startsWith('@@')
      )
        continue;
      model.fields.set(field[1] as string, field[2] as string);
      const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(line);
      if (rel) {
        model.relations.push({
          type: field[2] as string,
          fields: (rel[1] as string).split(',').map((f) => f.trim()),
        });
      }
    }
    models.set(name as string, model);
  }
  return models;
}

describe('schema.prisma and the tenant scoping rules agree', () => {
  const schema = parseSchema();

  it('finds the models (sanity check on the parser)', () => {
    expect(schema.size).toBeGreaterThanOrEqual(18);
    expect(schema.get('Task')?.fields.get('organizationId')).toBe('String');
  });

  it('every model is classified, and nothing classified is missing from the schema', () => {
    expect([...schema.keys()].sort()).toEqual(Object.keys(MODEL_SCOPES).sort());
  });

  it('a model has an organizationId column exactly when it is classified "column"', () => {
    for (const [name, model] of schema) {
      const hasColumn = model.fields.has('organizationId');
      const scopeOf = MODEL_SCOPES[name as ScopedModel];
      expect(hasColumn, `${name} (${scopeOf})`).toBe(scopeOf === 'column');
    }
  });

  it('line items are scoped through a real invoice relation', () => {
    const item = schema.get('InvoiceLineItem');
    expect(item?.fields.has('invoiceId')).toBe(true);
    expect(item?.relations.some((r) => r.type === 'Invoice')).toBe(true);
  });

  it('every entry in TENANT_REFERENCES is a real foreign key to the stated model', () => {
    for (const [model, refs] of Object.entries(TENANT_REFERENCES)) {
      for (const [field, target] of Object.entries(refs)) {
        const relation = schema
          .get(model)
          ?.relations.find((r) => r.fields.includes(field));
        expect(relation?.type, `${model}.${field}`).toBe(target);
      }
    }
  });

  it('EVERY foreign key to a tenant-owned model is listed, so none can skip the same-organisation check', () => {
    const missing: string[] = [];
    for (const [name, model] of schema) {
      for (const relation of model.relations) {
        const target = relation.type as ScopedModel;
        const targetScope = MODEL_SCOPES[target];
        // Pointing at the Organization itself, or at global rows (users), is not a tenant check.
        if (
          !targetScope ||
          targetScope === 'global' ||
          target === 'Organization'
        )
          continue;
        for (const field of relation.fields) {
          if (name === 'InvoiceLineItem' && field === 'invoiceId') continue; // covered by 'via-invoice'
          if (TENANT_REFERENCES[name as ScopedModel]?.[field] !== target) {
            missing.push(`${name}.${field} → ${target}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
