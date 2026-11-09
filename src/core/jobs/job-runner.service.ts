import { Injectable, Logger } from '@nestjs/common';
import { safeErrorMessage } from '../../common/redact.js';
import { AppConfigService } from '../config/config.service.js';
import { XrayService } from '../xray/xray.service.js';
import { jobEvent } from '../xray/xray.events.js';
import {
  JOB_LABELS,
  type JobContext,
  type JobData,
  type JobHandler,
  type JobName,
} from './jobs.types.js';
import { eventTime } from '../xray/xray.clock.js';

/**
 * Runs ONE attempt of a job and narrates it to the X-ray: active, then completed (with how
 * long it took), or retry (with how long until the next attempt), or failed (given up on).
 * Both queues (Redis and in-process) call this, so a job behaves, and shows up, the same way
 * wherever it runs.
 *
 * It rethrows a failure: the queue decides what happens next (BullMQ schedules the retry).
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);
  private readonly handlers = new Map<JobName, JobHandler<never>>();

  constructor(
    private readonly xray: XrayService,
    private readonly config: AppConfigService,
  ) {}

  register<N extends JobName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async execute<N extends JobName>(
    name: N,
    data: JobData[N],
    context: JobContext,
  ): Promise<void> {
    const handler = this.handlers.get(name) as JobHandler<N> | undefined;
    if (!handler) throw new Error(`No handler is registered for job "${name}"`);

    // Only a job that belongs to one organisation can be shown in that organisation's X-ray.
    const organizationId =
      'organizationId' in data && typeof data.organizationId === 'string'
        ? data.organizationId
        : undefined;
    const label = JOB_LABELS[name];
    const requestId = data.requestId;
    const say = (event: Parameters<typeof jobEvent>[0]) => {
      if (organizationId) this.xray.publish(organizationId, [jobEvent(event)]);
    };
    const base = {
      label,
      attempt: context.attempt,
      attempts: context.attempts,
      ...(requestId ? { requestId } : {}),
    };

    say({ ...base, ts: eventTime(), phase: 'active' });
    const started = performance.now();
    try {
      await handler(data, context);
    } catch (error) {
      const last = context.attempt >= context.attempts;
      // Log the cause, never the payload (it holds addresses and names), and hide any
      // address the provider echoed back in its error.
      this.logger.warn(
        `Job "${name}" attempt ${context.attempt}/${context.attempts} failed: ${safeErrorMessage(error)}`,
      );
      say({
        ...base,
        ts: eventTime(),
        durationMs: performance.now() - started,
        ...(last
          ? { phase: 'failed' as const }
          : {
              phase: 'retry' as const,
              // BullMQ's exponential backoff: the delay doubles after each failed attempt.
              nextDelayMs:
                this.config.get('JOB_BACKOFF_MS') * 2 ** (context.attempt - 1),
            }),
      });
      throw error;
    }
    say({
      ...base,
      ts: eventTime(),
      phase: 'completed',
      durationMs: performance.now() - started,
    });
  }
}
