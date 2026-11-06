import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { AppConfigService } from './core/config/config.service.js';
import { EnvValidationError, validateEnv } from './core/config/env.schema.js';
import { loadDotEnv } from './core/config/load-env.js';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // Validate before Nest starts so a config mistake prints one short, readable message
  // instead of a framework stack trace. (ConfigModule validates again; it is cheap and
  // keeps the module safe to use on its own, e.g. in tests.)
  validateEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Keep the unparsed body on req.rawBody (needed to verify Stripe webhook signatures).
    rawBody: true,
    // Default is process.abort() (core dump) on a startup error; we want a clean exit code.
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const port = app.get(AppConfigService).get('PORT');
  await app.listen(port);
  app.get(Logger).log(`API listening on port ${port} (docs at /docs)`);
}

bootstrap().catch((error: unknown) => {
  // Config mistakes get a short, readable message; anything else gets the full stack.
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
});
