import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  TenantContextMissingError,
  TenantViolationError,
} from './tenant-errors.js';
import {
  MODEL_SCOPES,
  type ScopedModel,
  collectReferences,
  scopeArgs,
} from './tenant-scope.js';

/** Raw SQL cannot be scoped, so the tenant client refuses it outright. */
const FORBIDDEN_MEMBERS = new Set<string | symbol>([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$connect',
  '$disconnect',
  '$extends',
  '$on',
]);

const lowerFirst = (name: string): string =>
  name.charAt(0).toLowerCase() + name.slice(1);

/** The few delegate methods the foreign-key check needs. */
type Counter = Record<string, { count: (args: unknown) => Promise<number> }>;

/**
 * The client of the interactive transaction currently running on this call chain, if any.
 *
 * The foreign-key check must run on the SAME connection as the surrounding transaction. A
 * check on a second connection would, under load, wait for a free connection while every
 * connection in the pool is held by a transaction that is itself waiting for its check:
 * a deadlock that only a timeout breaks.
 */
const activeTransaction = new AsyncLocalStorage<Counter>();

/** Strips the members that could bypass scoping (raw SQL, reconnecting, re-extending). */
function guard<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (FORBIDDEN_MEMBERS.has(property)) {
        throw new TenantViolationError(
          `${String(property)} is not available on the tenant client.`,
        );
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Wraps the database client so every query on tenant data is confined to one organisation,
 * taken from `getTenantId()` (the request context). This is the second line of defence
 * behind TenantGuard (ARCHITECTURE §8.2): even if a service forgets a filter, or is handed
 * another organisation's id, the query cannot see or change another tenant's rows.
 *
 * It fails closed:
 *  - no organisation in context → TenantContextMissingError (never "return everything");
 *  - global models (users, tokens) and raw SQL are refused;
 *  - foreign keys on writes must point at the caller's own organisation;
 *  - only interactive transactions are allowed (`$transaction(async (tx) => ...)`).
 */
export function createTenantClient(
  prisma: PrismaClient,
  getTenantId: () => string | undefined,
) {
  const extended = prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!(model in MODEL_SCOPES)) {
            throw new TenantViolationError(
              `${model} has not been classified in MODEL_SCOPES; add it before using it.`,
            );
          }
          const name = model as ScopedModel;
          if (MODEL_SCOPES[name] === 'global') {
            throw new TenantViolationError(
              `${name} is not tenant data and cannot be queried through the tenant client.`,
            );
          }
          const tenantId = getTenantId();
          if (!tenantId) throw new TenantContextMissingError(name, operation);

          const scoped = scopeArgs(name, operation, args, tenantId);
          // Counting through the (scoped) client is itself tenant-confined, so "does this
          // id exist" really means "does it exist IN THIS ORGANISATION".
          await assertReferencesInTenant(
            activeTransaction.getStore() ?? (extended as unknown as Counter),
            name,
            operation,
            scoped,
          );
          return query(scoped as typeof args);
        },
      },
    },
  });

  const wrapped = new Proxy(extended, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (arg: unknown, ...rest: unknown[]) => {
          if (typeof arg !== 'function') {
            throw new TenantViolationError(
              'Use an interactive transaction: $transaction(async (tx) => { ... }).',
            );
          }
          const run = arg as (tx: unknown) => unknown;
          return (
            target.$transaction as (...a: unknown[]) => Promise<unknown>
          ).call(
            target,
            (tx: Counter) => activeTransaction.run(tx, () => run(guard(tx))),
            ...rest,
          );
        };
      }
      if (FORBIDDEN_MEMBERS.has(property)) {
        throw new TenantViolationError(
          `${String(property)} is not available on the tenant client.`,
        );
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Omit<
    typeof extended,
    | '$queryRaw'
    | '$queryRawUnsafe'
    | '$executeRaw'
    | '$executeRawUnsafe'
    | '$connect'
    | '$disconnect'
    | '$extends'
    | '$on'
  >;
  return wrapped;
}

export type TenantClient = ReturnType<typeof createTenantClient>;

/** Each foreign key being written must reference a row owned by the current tenant. */
async function assertReferencesInTenant(
  db: Counter,
  model: ScopedModel,
  operation: string,
  scopedArgs: unknown,
): Promise<void> {
  for (const ref of collectReferences(model, operation, scopedArgs)) {
    if (MODEL_SCOPES[ref.model] === 'global') continue;
    const owned = await db[lowerFirst(ref.model)]?.count({
      where: { id: ref.id },
    });
    if (!owned) {
      throw new TenantViolationError(
        `${model}.${ref.field} refers to a ${ref.model} outside the current organisation.`,
      );
    }
  }
}
