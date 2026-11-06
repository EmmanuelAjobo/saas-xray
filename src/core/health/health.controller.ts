import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../../modules/auth/public.decorator.js';
import { DependencyHealthIndicators } from './dependency-health.indicators.js';

/**
 * Unversioned on purpose: hosts and load balancers probe `/health/*` and must not break
 * when the API moves from v1 to v2.
 */
@Public()
@SkipThrottle()
@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dependencies: DependencyHealthIndicators,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness: the process is up (no dependencies checked)',
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness: Postgres and Redis are reachable' })
  ready() {
    return this.health.check([
      () => this.dependencies.postgres(),
      () => this.dependencies.redisPing(),
    ]);
  }
}
