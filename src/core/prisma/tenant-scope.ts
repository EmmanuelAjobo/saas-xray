import { TenantViolationError } from './tenant-errors.js';

/**
 * How each database model relates to a tenant (an organisation). EVERY model in
 * prisma/schema.prisma must appear here exactly once; a test reads the schema and fails if
 * a model is added without being classified, so a new table can never silently skip scoping.
 *
 * - column:      rows carry `organizationId`; queries are filtered by it.
 * - self:        the Organization table itself; filtered by `id`.
 * - via-invoice: rows have no `organizationId` but belong to an invoice, which does.
 * - global:      not owned by any organisation (identity, tokens, webhook ids). The scoped
 *                client refuses these: code that needs them must say so by using the
 *                unscoped PrismaService, which is easy to spot in review.
 */
export const MODEL_SCOPES = {
  Membership: 'column',
  Invitation: 'column',
  Subscription: 'column',
  ApiKey: 'column',
  Task: 'column',
  Client: 'column',
  Invoice: 'column',
  FileObject: 'column',
  AuditLog: 'column',
  Notification: 'column',
  ReportJob: 'column',
  Organization: 'self',
  InvoiceLineItem: 'via-invoice',
  User: 'global',
  OAuthAccount: 'global',
  RefreshToken: 'global',
  AuthToken: 'global',
  StripeEvent: 'global',
} as const;

export type ScopedModel = keyof typeof MODEL_SCOPES;
type Scope = (typeof MODEL_SCOPES)[ScopedModel];

type Json = Record<string, unknown>;

/** Filters by non-unique fields: the tenant condition is ANDed in. */
const FILTER_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);
/** Address one row by a unique key: the tenant condition is ANDed in next to it. */
const UNIQUE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
]);
const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

export const isCreateOperation = (operation: string): boolean =>
  CREATE_OPERATIONS.has(operation);

/** The condition that confines a query on a model with this scope to one tenant. */
export function tenantCondition(
  scope: Exclude<Scope, 'global'>,
  tenantId: string,
): Json {
  switch (scope) {
    case 'column':
      return { organizationId: tenantId };
    case 'self':
      return { id: tenantId };
    case 'via-invoice':
      return { invoice: { organizationId: tenantId } };
  }
}

/** `{ ...where, AND: [tenant, ...existing AND] }`: the caller's own filters stay intact. */
function andTenant(where: unknown, condition: Json): Json {
  const existing = (where ?? {}) as Json;
  const previousAnd = existing.AND;
  const rest: unknown[] =
    previousAnd === undefined
      ? []
      : Array.isArray(previousAnd)
        ? previousAnd
        : [previousAnd];
  return { ...existing, AND: [condition, ...rest] };
}

/**
 * Data being written must not move a row to another tenant or point at one. Scalars like
 * `organizationId` are forced; the relation form (`organization: { connect }`) is refused
 * outright because it would let a caller name any organisation.
 */
function scopeData(
  model: ScopedModel,
  scope: Exclude<Scope, 'global'>,
  data: unknown,
  tenantId: string,
  { creating }: { creating: boolean },
): unknown {
  if (data === null || typeof data !== 'object') return data;
  const input = data as Json;

  if ('organization' in input) {
    throw new TenantViolationError(
      `${model}: set organizationId directly; the "organization" relation form is not allowed on the tenant client.`,
    );
  }
  if (scope === 'via-invoice' && 'invoice' in input) {
    throw new TenantViolationError(
      `${model}: set invoiceId directly; the "invoice" relation form is not allowed on the tenant client.`,
    );
  }
  if (scope === 'column') {
    const given = input.organizationId;
    if (given !== undefined && given !== tenantId) {
      throw new TenantViolationError(
        `${model}: organizationId does not match the current organisation.`,
      );
    }
    return creating ? { ...input, organizationId: tenantId } : input;
  }
  if (scope === 'self' && 'id' in input && input.id !== tenantId) {
    throw new TenantViolationError('Organization: the id cannot be changed.');
  }
  return input;
}

/**
 * Returns the arguments of a database call rewritten so they can only touch `tenantId`'s
 * data. Pure (no database access), so every rule below is unit-tested exhaustively.
 *
 * Anything this does not recognise is refused rather than passed through: failing closed is
 * the point of this layer.
 */
export function scopeArgs(
  model: ScopedModel,
  operation: string,
  args: unknown,
  tenantId: string,
): unknown {
  const scope = MODEL_SCOPES[model];
  if (scope === 'global') {
    throw new TenantViolationError(
      `${model} is not tenant data and cannot be queried through the tenant client.`,
    );
  }
  const input = (args ?? {}) as Json;
  const condition = tenantCondition(scope, tenantId);

  if (FILTER_OPERATIONS.has(operation) || UNIQUE_OPERATIONS.has(operation)) {
    const scoped: Json = { ...input, where: andTenant(input.where, condition) };
    if (
      operation === 'update' ||
      operation === 'updateMany' ||
      operation === 'updateManyAndReturn'
    ) {
      scoped.data = scopeData(model, scope, input.data, tenantId, {
        creating: false,
      });
    }
    return scoped;
  }

  if (operation === 'create') {
    if (scope === 'self') {
      throw new TenantViolationError(
        'Organization: cannot be created through the tenant client.',
      );
    }
    return {
      ...input,
      data: scopeData(model, scope, input.data, tenantId, { creating: true }),
    };
  }

  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    if (scope === 'self') {
      throw new TenantViolationError(
        'Organization: cannot be created through the tenant client.',
      );
    }
    const rows = Array.isArray(input.data) ? input.data : [input.data];
    const scopedRows = rows.map((row) =>
      scopeData(model, scope, row, tenantId, { creating: true }),
    );
    return {
      ...input,
      data: Array.isArray(input.data) ? scopedRows : scopedRows[0],
    };
  }

  if (operation === 'upsert') {
    if (scope === 'self') {
      throw new TenantViolationError(
        'Organization: upsert is not allowed through the tenant client.',
      );
    }
    return {
      ...input,
      where: andTenant(input.where, condition),
      create: scopeData(model, scope, input.create, tenantId, {
        creating: true,
      }),
      update: scopeData(model, scope, input.update, tenantId, {
        creating: false,
      }),
    };
  }

  throw new TenantViolationError(
    `${model}.${operation} is not supported on the tenant client.`,
  );
}

/**
 * Foreign keys that must point at a row in the SAME organisation. The database only proves
 * the target exists; this table lets the data layer prove it is the caller's own, which closes
 * the "foreign keys do not enforce same-organisation" limitation recorded in ARCHITECTURE §6.
 * (User ids are global and not listed.) A test checks every entry against schema.prisma.
 */
export const TENANT_REFERENCES: Partial<
  Record<ScopedModel, Record<string, ScopedModel>>
> = {
  Invoice: { clientId: 'Client', pdfFileId: 'FileObject' },
  InvoiceLineItem: { invoiceId: 'Invoice' },
  Task: { assigneeId: 'Membership', createdById: 'Membership' },
  FileObject: { taskId: 'Task' },
  ReportJob: { fileId: 'FileObject' },
};

export interface TenantReference {
  field: string;
  model: ScopedModel;
  id: string;
}

/** A scalar foreign key value: `"id"` or Prisma's update form `{ set: "id" }`. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'set' in value) {
    const inner = (value as { set: unknown }).set;
    return typeof inner === 'string' ? inner : undefined;
  }
  return undefined;
}

/**
 * Every foreign-key value a write would store, so the caller can verify each belongs to the
 * current tenant. Reads and deletes reference nothing and return an empty list.
 */
export function collectReferences(
  model: ScopedModel,
  operation: string,
  args: unknown,
): TenantReference[] {
  const fields = TENANT_REFERENCES[model];
  if (!fields) return [];
  const input = (args ?? {}) as Json;

  let payloads: unknown[];
  switch (operation) {
    case 'create':
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      payloads = [input.data];
      break;
    case 'createMany':
    case 'createManyAndReturn':
      payloads = Array.isArray(input.data) ? input.data : [input.data];
      break;
    case 'upsert':
      payloads = [input.create, input.update];
      break;
    default:
      return [];
  }

  const found = new Map<string, TenantReference>();
  for (const payload of payloads) {
    if (payload === null || typeof payload !== 'object') continue;
    for (const [field, target] of Object.entries(fields)) {
      const id = idOf((payload as Json)[field]);
      if (id !== undefined)
        found.set(`${field}:${id}`, { field, model: target, id });
    }
  }
  return [...found.values()];
}
