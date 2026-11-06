import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicy } from './rate-limit.policies.js';

export const RATE_LIMIT_POLICY_KEY = 'rateLimitPolicy';

/** Applies a named policy (see rate-limit.policies.ts) instead of the app-wide default. */
export const RateLimit = (policy: RateLimitPolicy): MethodDecorator =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);
