import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { MINUTE_MS } from '../../common/time.js';
import { AppConfigService } from '../config/config.service.js';
import { ConfiguredThrottlerGuard } from './configured-throttler.guard.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

/** Exists so the throttler's async factory can inject the Redis-backed storage. */
@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
class ThrottlerStorageModule {}

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [RedisThrottlerStorage, AppConfigService],
      useFactory: (
        storage: RedisThrottlerStorage,
        config: AppConfigService,
      ) => ({
        storage,
        // The allowance for any route without its own @RateLimit policy: per client IP.
        throttlers: [
          {
            name: 'default',
            limit: config.get('RATE_LIMIT_DEFAULT_PER_MINUTE'),
            ttl: MINUTE_MS,
          },
        ],
      }),
    }),
  ],
  // Registered before the auth guard (see AppModule order): cheap rejection comes first.
  providers: [{ provide: APP_GUARD, useClass: ConfiguredThrottlerGuard }],
})
export class RateLimitModule {}
