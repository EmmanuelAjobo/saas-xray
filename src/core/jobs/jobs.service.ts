import { Inject, Injectable, Logger } from '@nestjs/common';
import { BackgroundTasks } from '../background/background-tasks.service.js';
import { AppConfigService } from '../config/config.service.js';
import { RequestContextService } from '../context/request-context.service.js';
import { jobEvent } from '../xray/xray.events.js';
import { recordXrayStep } from '../xray/xray.trace.js';
import { JobRunner } from './job-runner.service.js';
import {
  JOB_LABELS,
  JOB_QUEUE,
  type JobData,
  type JobName,
  type JobQueue,
} from './jobs.types.js';
import { eventTime } from '../xray/xray.clock.js';

/**
 * How the rest of the app queues background work.
 *
 * Queuing is cheap and returns at once, so the click that caused it is not kept waiting. If
 * the queue itself is unreachable (Redis down) the work is run in-process instead, exactly
 * as before the queue existed, so an invoice email is delayed or retried less, never lost to
 * an outage.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly runner: JobRunner,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
    private readonly context: RequestContextService,
  ) {}

  /**
   * @param options.jobId makes queuing idempotent: a second job with the same id is ignored
   *   while the first still exists (it must not contain ":").
   */
  async enqueue<N extends JobName>(
    name: N,
    data: JobData[N],
    options: { jobId?: string } = {},
  ): Promise<void> {
    // Tie the job's later X-ray events to the click that queued it.
    const requestId = this.context.requestId;
    const payload = requestId ? { ...data, requestId } : data;
    // The moment it was queued is BEFORE the queue takes it: a worker may start on it before
    // `add` even returns, and "queued" must never be timestamped later than the work it caused.
    const queuedAt = eventTime();
    try {
      await this.queue.add(name, payload, options);
    } catch (error) {
      this.logger.warn(
        `Could not queue job "${name}"; running it in-process instead: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.background.run(`job:${name}`, () =>
        this.runner.execute(name, payload, {
          attempt: 1,
          attempts: 1,
        }),
      );
      return;
    }
    recordXrayStep(
      jobEvent({
        ts: queuedAt,
        label: JOB_LABELS[name],
        phase: 'queued',
        attempts: this.config.get('EMAIL_JOB_ATTEMPTS'),
      }),
    );
  }
}
