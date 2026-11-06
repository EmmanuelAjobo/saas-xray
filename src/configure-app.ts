import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppConfigService } from './core/config/config.service.js';
import { requestIdMiddleware } from './core/context/request-id.js';
import { SWAGGER_PATH, setupSwagger } from './swagger.js';

/**
 * Everything that must be configured on the live app object (as opposed to via DI).
 * Shared by main.ts and the e2e tests, so tests exercise exactly what production runs.
 *
 * Order matters: the request id comes first so every later layer (logs, error bodies,
 * response headers) agrees on it.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);

  // Behind a load balancer, trust N hops so req.ip (rate limiting, audit log) is the client's.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS'));

  app.use(requestIdMiddleware);

  // Security headers. Swagger UI needs inline scripts/styles, which the strict default CSP
  // forbids, so only the docs pages get a relaxed policy; the API itself stays strict.
  const strictHelmet = helmet();
  const docsHelmet = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isDocs =
      req.path === `/${SWAGGER_PATH}` ||
      req.path.startsWith(`/${SWAGGER_PATH}/`);
    (isDocs ? docsHelmet : strictHelmet)(req, res, next);
  });

  app.use(cookieParser());

  // Exact-origin allowlist. Credentials are allowed (refresh-token cookie), so a wildcard
  // would be both invalid and dangerous.
  app.enableCors({
    origin: [config.get('WEB_ORIGIN')],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Request-Id',
      'X-API-Key',
      'Idempotency-Key',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: config.get('CORS_MAX_AGE_SECONDS'),
  });

  // /v1/... for everything unless a controller opts out (health is VERSION_NEUTRAL).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // SIGTERM/SIGINT run module destroy hooks: close DB, Redis, queues; finish in-flight work.
  app.enableShutdownHooks();

  setupSwagger(app);
}
