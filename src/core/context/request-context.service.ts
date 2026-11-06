import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Role } from '../../generated/prisma/client.js';

/** Who the current request is acting as. Set by the auth guard. */
export interface RequestAuth {
  userId: string;
  sessionId: string;
  isDemo: boolean;
}

/** Which organisation the request is scoped to, and the caller's role in it. Set by TenantGuard. */
export interface RequestTenant {
  organizationId: string;
  membershipId: string;
  role: Role;
}

const AUTH_KEY = 'auth';
const TENANT_KEY = 'tenant';

/**
 * Typed access to per-request state, backed by AsyncLocalStorage (nestjs-cls), so any
 * service can read "who/what is this request" without threading parameters through.
 *
 * Carries the request id, the authenticated user and the organisation in scope, here, so
 * nobody else touches raw CLS string keys.
 */
@Injectable()
export class RequestContextService {
  constructor(private readonly cls: ClsService) {}

  /** The current request's id, or undefined outside a request (workers, startup). */
  get requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined;
  }

  /** The authenticated caller, or undefined for public routes and outside a request. */
  get auth(): RequestAuth | undefined {
    return this.cls.isActive()
      ? this.cls.get<RequestAuth | undefined>(AUTH_KEY)
      : undefined;
  }

  setAuth(auth: RequestAuth): void {
    if (this.cls.isActive()) this.cls.set(AUTH_KEY, auth);
  }

  /** The organisation in scope, or undefined on routes that are not under /orgs/:orgId. */
  get tenant(): RequestTenant | undefined {
    return this.cls.isActive()
      ? this.cls.get<RequestTenant | undefined>(TENANT_KEY)
      : undefined;
  }

  setTenant(tenant: RequestTenant): void {
    if (this.cls.isActive()) this.cls.set(TENANT_KEY, tenant);
  }

  /**
   * Runs `fn` as if inside a request for this organisation. For background jobs (no HTTP
   * request) and tests: every tenant-scoped query inside is confined to it. Values from an
   * enclosing context (request id, user) are kept.
   */
  runWithTenant<T>(tenant: RequestTenant, fn: () => T): T {
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set(TENANT_KEY, tenant);
      return fn();
    });
  }
}
