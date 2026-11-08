import type { Writable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';
import { buildPinoHttpOptions } from '../../src/core/logger/logger.config.js';
import { BackgroundTasks } from '../../src/core/background/background-tasks.service.js';
import { MAIL_TRANSPORT } from '../../src/core/mail/mail.types.js';
import { PrismaService } from '../../src/core/prisma/prisma.service.js';
import { TenantPrismaService } from '../../src/core/prisma/tenant-prisma.service.js';
import { RedisThrottlerStorage } from '../../src/core/rate-limit/redis-throttler.storage.js';
import { RedisService } from '../../src/core/redis/redis.service.js';
import { MemoryXrayStore } from '../../src/core/xray/memory-xray.store.js';
import { XRAY_STORE } from '../../src/core/xray/xray.store.js';
import { FakeMailTransport } from './fake-mail.js';
import { ProbeController } from './probe.controller.js';
import { TenantProbeController } from './tenant-probe.controller.js';

export type DependencyMode = 'up' | 'down' | 'hang';

/** Flip these during a test to simulate an outage of a backing service. */
export interface DependencyStubs {
  postgres: DependencyMode;
  redis: DependencyMode;
}

export interface TestAppOptions {
  /** Environment overrides, applied while the app boots (e.g. a short REQUEST_TIMEOUT_MS). */
  env?: Record<string, string>;
  /**
   * Capture the app's real request logs (pino-http, production options) into this stream.
   * Without it the logger stays silent.
   */
  logStream?: Writable;
  /**
   * Use the real PrismaService against DATABASE_URL (the test database) instead of the stub.
   * For the integration suite only; HTTP-level tests stay infrastructure-free.
   */
  realDatabase?: boolean;
}

async function simulate<T>(mode: DependencyMode, ok: T): Promise<T> {
  if (mode === 'down') throw new Error('connect ECONNREFUSED 10.1.2.3:5432');
  if (mode === 'hang') return new Promise<T>(() => undefined);
  return ok;
}

/**
 * Boots the real AppModule + the real `configureApp()` (same code as production), with only
 * Postgres and Redis replaced by controllable stubs. Real-infrastructure checks live in
 * the integration suite, which needs Docker.
 */
export async function createTestApp({
  env = {},
  logStream,
  realDatabase = false,
}: TestAppOptions = {}) {
  const stubs: DependencyStubs = { postgres: 'up', redis: 'up' };

  // The config provider reads process.env while the module compiles; restore right after.
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);

  try {
    const mail = new FakeMailTransport();
    let builder = Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController, TenantProbeController],
    })
      .overrideProvider(RedisService)
      .useValue({ client: { ping: () => simulate(stubs.redis, 'PONG') } })
      // Rate-limit counters in memory (one fresh set per app), mail captured, never sent.
      .overrideProvider(RedisThrottlerStorage)
      .useValue(new ThrottlerStorageService())
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(mail)
      // X-ray events kept in memory: tests of the layers above need no Redis streams.
      .overrideProvider(XRAY_STORE)
      .useClass(MemoryXrayStore);
    if (!realDatabase) {
      builder = builder
        .overrideProvider(PrismaService)
        .useValue({
          $queryRaw: () => simulate(stubs.postgres, [{ '?column?': 1 }]),
        })
        // The scoped client wraps the real one; with no database there is nothing to wrap.
        .overrideProvider(TenantPrismaService)
        .useValue({ client: {} });
    }

    if (logStream) {
      // Same options production uses, but writing to the test's stream as JSON.
      builder.overrideProvider(PARAMS_PROVIDER_TOKEN).useValue({
        pinoHttp: [
          buildPinoHttpOptions({ level: 'info', pretty: false }),
          logStream,
        ],
      });
    }

    const moduleRef = await builder.compile();

    // logger: false keeps simulated-outage errors out of the test output.
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
      logger: false,
    });
    configureApp(app);
    // Listen on an ephemeral port: supertest then reuses one server instead of opening
    // (and leaking listeners on) a fresh one per request.
    await app.listen(0);
    return { app, stubs, mail, background: app.get(BackgroundTasks) };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
