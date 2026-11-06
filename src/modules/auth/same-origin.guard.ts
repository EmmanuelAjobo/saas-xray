import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { AppConfigService } from '../../core/config/config.service.js';

/**
 * CSRF defence for the endpoints that act on the refresh cookie (refresh, logout).
 *
 * The cookie is SameSite=Lax and scoped to /v1/auth, which already blocks most cross-site
 * requests; this adds the belt to those braces: if the browser says the request came from
 * some other origin, refuse it. Requests with no Origin header (curl, server-to-server) are
 * allowed: a forged cross-site browser request always carries one.
 */
@Injectable()
export class SameOriginGuard implements CanActivate {
  private readonly allowed: Set<string>;

  constructor(config: AppConfigService) {
    this.allowed = new Set([config.get('WEB_ORIGIN')]);
    if (!config.isProduction) {
      // Lets Swagger UI ("Try it out") on the API's own port use the cookie in development.
      this.allowed.add(`http://localhost:${config.get('PORT')}`);
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<Request>().headers.origin;
    if (origin !== undefined && !this.allowed.has(origin)) {
      throw new ForbiddenError('Cross-origin request refused.');
    }
    return true;
  }
}
