import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/config.service.js';

/**
 * General-purpose Redis connection (cache, rate-limit counters, pub/sub publishing).
 *
 * BullMQ and Socket.IO need their own dedicated connections with different settings;
 * they create those themselves in the milestones that add them.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.get('REDIS_URL'), {
      // Commands fail after a couple of retries instead of hanging requests forever.
      maxRetriesPerRequest: config.get('REDIS_MAX_RETRIES_PER_REQUEST'),
      connectionName: 'saas-xray-api',
    });
    // Without a listener, an 'error' event would crash the process. Redis being briefly
    // unavailable must degrade readiness, not kill the API.
    this.client.on('error', (error: Error) => {
      this.logger.error(`Redis connection error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
