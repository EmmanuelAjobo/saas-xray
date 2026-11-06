import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors.js';
import type { RequestContextService } from '../../core/context/request-context.service.js';
import type { PrismaService } from '../../core/prisma/prisma.service.js';
import type { Role } from '../../generated/prisma/client.js';
import { PermissionsGuard } from './permissions.guard.js';
import { RequirePermission } from './require-permission.decorator.js';
import { TenantGuard } from './tenant.guard.js';

const ORG = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const USER = '0198a2b4-5d6e-7f80-9a1b-aaaaaaaaaaaa';

function contextFor(
  request: Record<string, unknown>,
  target: { handler?: () => void; cls?: new () => unknown } = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => target.handler ?? (() => undefined),
    getClass: () => target.cls ?? class {},
  } as unknown as ExecutionContext;
}

describe('TenantGuard', () => {
  const lookups: unknown[] = [];
  let membership: { id: string; role: Role } | null;
  const prisma = {
    membership: {
      findUnique: (args: unknown) => {
        lookups.push(args);
        return Promise.resolve(membership);
      },
    },
  } as unknown as PrismaService;
  const setTenant = vi.fn();
  const guard = new TenantGuard(prisma, {
    setTenant,
  } as unknown as RequestContextService);

  beforeEach(() => {
    lookups.length = 0;
    setTenant.mockClear();
    membership = { id: 'm1', role: 'ADMIN' };
  });

  it('lets routes without :orgId through untouched, without any database lookup', async () => {
    const request = { params: {}, auth: { userId: USER } };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(lookups).toHaveLength(0);
  });

  it('records the membership and role for a member', async () => {
    const request: Record<string, unknown> = {
      params: { orgId: ORG },
      auth: { userId: USER },
    };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.tenant).toEqual({
      organizationId: ORG,
      membershipId: 'm1',
      role: 'ADMIN',
    });
    expect(setTenant).toHaveBeenCalledWith(request.tenant);
    expect(lookups[0]).toMatchObject({
      where: {
        userId_organizationId: { userId: USER, organizationId: ORG },
      },
    });
  });

  it('answers 404 (never 403) for a non-member, so the organisation is not confirmed to exist', async () => {
    membership = null;
    const request = { params: { orgId: ORG }, auth: { userId: USER } };
    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it.each(['not-a-uuid', '123', '../../etc', "' OR 1=1 --", '', ORG + 'x'])(
    'answers the same 404 for a malformed id (%j) without touching the database',
    async (orgId) => {
      const request = { params: { orgId }, auth: { userId: USER } };
      await expect(
        guard.canActivate(contextFor(request)),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(lookups).toHaveLength(0);
    },
  );

  it('uses the same message for every kind of "not found", so they cannot be told apart', async () => {
    membership = null;
    const messages: string[] = [];
    for (const orgId of [ORG, 'nonsense']) {
      try {
        await guard.canActivate(
          contextFor({ params: { orgId }, auth: { userId: USER } }),
        );
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(new Set(messages).size).toBe(1);
  });

  it('refuses a tenant route reached without authentication', async () => {
    const request = { params: { orgId: ORG } };
    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe('PermissionsGuard (fail closed)', () => {
  const guard = new PermissionsGuard(new Reflector());

  class OwnerOnly {
    @RequirePermission('billing:manage') handler() {}
  }
  class Undeclared {
    handler() {}
  }
  const handlerOf = (cls: new () => { handler: () => void }) =>
    cls.prototype.handler as () => void;
  const tenantRequest = (role: Role) => ({
    params: { orgId: ORG },
    tenant: { organizationId: ORG, membershipId: 'm1', role },
  });

  it('ignores routes that are not under /orgs/:orgId', () => {
    expect(guard.canActivate(contextFor({ params: {} }))).toBe(true);
  });

  it.each([
    ['OWNER', true],
    ['ADMIN', false],
    ['MEMBER', false],
  ] as const)('billing:manage for %s allowed=%s', (role, allowed) => {
    const context = contextFor(tenantRequest(role), {
      handler: handlerOf(OwnerOnly),
    });
    if (allowed) expect(guard.canActivate(context)).toBe(true);
    else expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('REFUSES a tenant route that declares no permission, even for the owner', () => {
    const context = contextFor(tenantRequest('OWNER'), {
      handler: handlerOf(Undeclared),
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('refuses a request that reaches it without a resolved membership', () => {
    const context = contextFor(
      { params: { orgId: ORG } },
      { handler: handlerOf(OwnerOnly) },
    );
    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });
});
