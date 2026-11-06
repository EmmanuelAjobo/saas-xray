import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UnauthenticatedError } from '../../common/errors/domain-errors.js';
import {
  type RequestAuth,
  RequestContextService,
} from '../../core/context/request-context.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { TokenService } from './token.service.js';

const BEARER = /^Bearer ([A-Za-z0-9\-_.]+)$/;

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly context: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { auth?: RequestAuth }>();
    const match = BEARER.exec(request.headers.authorization ?? '');
    const claims = match
      ? await this.tokens.verifyAccessToken(match[1] as string)
      : undefined;
    // One message for missing, malformed, expired and forged tokens: nothing to probe.
    if (!claims) throw new UnauthenticatedError('Authentication required.');

    request.auth = claims;
    this.context.setAuth(claims);
    return true;
  }
}
