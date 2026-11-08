import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  // `upgrade-insecure-requests` (helmet's default) makes Safari refuse plain-http localhost,
  // so it is kept for production only, where everything is served over https anyway.
  const strictHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'upgrade-insecure-requests': config.isProduction ? [] : null,
      },
    },
  });
  const docsHelmet = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isDocs =
      req.path === `/${SWAGGER_PATH}` ||
      req.path.startsWith(`/${SWAGGER_PATH}/`);
    (isDocs ? docsHelmet : strictHelmet)(req, res, next);
  });

  app.use(cookieParser());

  serveWebApp(app);

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

/** The test files that live next to the page's scripts are not part of the site. */
const WEB_SPEC_FILE = /\.spec\.js$/;

/**
 * Serves the demo page (the `web/` folder) at `/`. It is plain static files, served by the
 * API itself, so the page and the API share one origin: no CORS, and the sign-in cookie
 * works without a custom domain. API routes (/v1, /docs, /health) are untouched: a path
 * that is not a file falls straight through to them.
 */
function serveWebApp(app: NestExpressApplication): void {
  const root = fileURLToPath(new URL('../web', import.meta.url));
  if (!existsSync(root)) return; // e.g. an image built without the page
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (WEB_SPEC_FILE.test(req.path)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    next();
  });
  // Revalidated on every load (cheap 304s thanks to ETags): a deploy shows up immediately.
  app.useStaticAssets(root, {
    index: 'index.html',
    dotfiles: 'ignore',
    maxAge: 0,
  });
}
