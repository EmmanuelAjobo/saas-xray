import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler/dist/throttler.guard.interface.js';
import { AppConfigService } from '../config/config.service.js';
import { RATE_LIMIT_POLICY_KEY } from './rate-limit.decorator.js';
import {
  RATE_LIMIT_POLICIES,
  type RateLimitPolicy,
} from './rate-limit.policies.js';

/**
 * The stock throttler guard, except that routes with `@RateLimit(policy)` get their limit
 * from the environment (looked up per request) instead of a number baked into the code.
 */
@Injectable()
export class ConfiguredThrottlerGuard extends ThrottlerGuard {
  @Inject(AppConfigService) private readonly config!: AppConfigService;

  protected override handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const name = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(
      RATE_LIMIT_POLICY_KEY,
      [props.context.getHandler(), props.context.getClass()],
    );
    if (!name) return super.handleRequest(props);

    const policy: {
      limit: Parameters<AppConfigService['get']>[0];
      windowMs: number;
      tracker?: (req: Record<string, unknown>) => string;
    } = RATE_LIMIT_POLICIES[name];
    return super.handleRequest({
      ...props,
      limit: this.config.get(policy.limit) as number,
      ttl: policy.windowMs,
      getTracker: policy.tracker ?? props.getTracker,
    });
  }
}
