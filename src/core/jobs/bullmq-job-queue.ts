import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { MINUTE_MS, SECOND_MS } from '../../common/time.js';
import { AppConfigService } from '../config/config.service.js';
import { JobRunner } from './job-runner.service.js';
import type { JobData, JobName, JobQueue } from './jobs.types.js';

/** The recurring job that marks past-due invoices overdue. */
const OVERDUE_SCHEDULER_ID = 'overdue-sweep';

/**
 * At start-up the queue waits this long for Redis, then (for the schedule) keeps trying in
 * the background every so often, never blocking the app from booting. Fixed start-up
 * behaviour, not a tunable.
 */
const SCHEDULER_READY_WAIT_MS = 5 * SECOND_MS;
const SCHEDULER_RETRY_MS = 5 * SECOND_MS;
const SCHEDULER_MAX_RETRIES = 60;

/**
 * The real queue: jobs live in Redis (BullMQ), so they survive a restart, are retried with
 * back-off, and can be run by any process.
 *
 * Two Redis connections, deliberately different:
 *  - the PRODUCER (queuing from a request) fails fast when Redis is down, so a request is
 *    never left hanging on it;
 *  - the WORKER must wait for Redis indefinitely (BullMQ requires it), which is fine because
 *    nobody is waiting on it.
 */
export class BullMqJobQueue implements JobQueue, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullMqJobQueue.name);
  private readonly producerConnection: Redis;
  private workerConnection: Redis | undefined;
  /** Created only once the connection is ready (see `ensureQueue`). */
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: JobRunner,
  ) {
    this.producerConnection = new Redis(this.config.get('REDIS_URL'), {
      maxRetriesPerRequest: this.config.get('REDIS_MAX_RETRIES_PER_REQUEST'),
      enableOfflineQueue: false,
      connectionName: 'saas-xray-jobs-producer',
    });
    this.producerConnection.on('error', (error: Error) => {
      this.logger.error(`Job queue connection error: ${error.message}`);
    });
  }

  /**
   * The BullMQ queue, created on first use and ONLY once the connection is ready.
   *
   * Why not in the constructor: with `skipWaitingForReady` (below) BullMQ talks to Redis
   * straight away, which fails if the connection is not up yet. Waiting for "ready" first
   * also gives the behaviour we want: when Redis is down this throws at once, so the caller
   * runs the work in-process, instead of hanging (and instead of a job that is queued late,
   * after the work was already done in-process: a duplicate email).
   */
  private ensureQueue(): Queue {
    if (this.queue) return this.queue;
    if (this.producerConnection.status !== 'ready') {
      throw new Error('The job queue is not connected to Redis');
    }
    this.queue = new Queue(this.config.get('JOBS_QUEUE_NAME'), {
      connection: this.producerConnection,
      // With Redis down, every command fails at once (the connection also has
      // enableOfflineQueue: false) instead of waiting for it to come back.
      skipWaitingForReady: true,
      defaultJobOptions: {
        attempts: this.config.get('EMAIL_JOB_ATTEMPTS'),
        backoff: {
          type: 'exponential',
          delay: this.config.get('JOB_BACKOFF_MS'),
        },
        removeOnComplete: {
          age: this.config.get('JOB_KEEP_COMPLETED_SECONDS'),
          count: this.config.get('JOB_KEEP_COMPLETED_COUNT'),
        },
        // Failed jobs are the dead-letter set: kept for inspection, then dropped.
        removeOnFail: { age: this.config.get('JOB_KEEP_FAILED_SECONDS') },
      },
    });
    this.queue.on('error', (error: Error) => {
      this.logger.error(`Job queue error: ${error.message}`);
    });
    return this.queue;
  }

  /** Resolves when the producer connection is ready, or rejects after `ms`. */
  private waitForConnection(ms: number): Promise<void> {
    const connection = this.producerConnection;
    if (connection.status === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.off('ready', onReady);
        reject(new Error('Redis is not ready yet'));
      }, ms);
      timer.unref();
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      connection.once('ready', onReady);
    });
  }

  async add<N extends JobName>(
    name: N,
    data: JobData[N],
    options: { jobId?: string } = {},
  ): Promise<void> {
    await this.ensureQueue().add(
      name,
      data,
      options.jobId ? { jobId: options.jobId } : {},
    );
  }

  async onModuleInit(): Promise<void> {
    // Give the connection a moment, so the first request after a boot does not find the queue
    // "not connected yet" and needlessly fall back to running its work in-process. Bounded:
    // with Redis down the app still boots, after this wait.
    try {
      await this.waitForConnection(SCHEDULER_READY_WAIT_MS);
    } catch (error) {
      this.logger.warn(
        `The job queue is not connected yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!this.config.get('WORKER_ENABLED')) return;
    try {
      this.startWorker();
    } catch (error) {
      // Redis being down at boot must not stop the API; the worker retries its own connection.
      this.logger.error(
        `Could not start the job worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // Normally Redis is there and this finishes at once. If not, boot carries on and the
    // schedule is created in the background as soon as Redis answers.
    if (!(await this.trySyncScheduler())) this.retrySchedulerLater(1);
  }

  /** One attempt to create (or remove) the schedule. @returns whether it worked */
  private async trySyncScheduler(): Promise<boolean> {
    try {
      await this.waitForConnection(SCHEDULER_READY_WAIT_MS);
      await this.syncOverdueScheduler(this.ensureQueue());
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not set up the overdue schedule yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private retrySchedulerLater(attempt: number): void {
    if (this.closing) return;
    if (attempt > SCHEDULER_MAX_RETRIES) {
      this.logger.error(
        'Giving up on the overdue schedule: it will exist after the next restart with Redis up.',
      );
      return;
    }
    this.retryTimer = setTimeout(() => {
      void this.trySyncScheduler().then((ok) => {
        if (!ok) this.retrySchedulerLater(attempt + 1);
      });
    }, SCHEDULER_RETRY_MS);
    this.retryTimer.unref();
  }

  private startWorker(): void {
    this.workerConnection = new Redis(this.config.get('REDIS_URL'), {
      maxRetriesPerRequest: null, // required for a worker: it blocks waiting for jobs
      connectionName: 'saas-xray-jobs-worker',
    });
    this.workerConnection.on('error', (error: Error) => {
      this.logger.error(`Job worker connection error: ${error.message}`);
    });
    this.worker = new Worker(
      this.config.get('JOBS_QUEUE_NAME'),
      (job) =>
        this.runner.execute(job.name as JobName, job.data as JobData[JobName], {
          attempt: job.attemptsMade + 1,
          attempts: job.opts.attempts ?? 1,
        }),
      {
        connection: this.workerConnection,
        concurrency: this.config.get('JOB_WORKER_CONCURRENCY'),
      },
    );
    this.worker.on('error', (error: Error) => {
      this.logger.error(`Job worker error: ${error.message}`);
    });
  }

  /**
   * Creates (or updates) the recurring overdue sweep. Safe to run from several processes and
   * on every start: the scheduler is identified by name, so it exists exactly once.
   */
  private async syncOverdueScheduler(queue: Queue): Promise<void> {
    const minutes = this.config.get('OVERDUE_SWEEP_INTERVAL_MINUTES');
    if (minutes === 0) {
      await queue.removeJobScheduler(OVERDUE_SCHEDULER_ID);
      return;
    }
    await queue.upsertJobScheduler(
      OVERDUE_SCHEDULER_ID,
      { every: minutes * MINUTE_MS },
      // A sweep that fails is simply replaced by the next scheduled one: no retries.
      { name: 'overdue-sweep', data: {}, opts: { attempts: 1 } },
    );
  }

  /** Shutdown: let running jobs finish, then close the worker, the queue and both connections. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // Let running jobs finish (up to a few seconds), then close everything.
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of [this.workerConnection, this.producerConnection]) {
      if (!connection) continue;
      try {
        await Promise.race([
          connection.quit(),
          new Promise((resolve) => setTimeout(resolve, 2 * SECOND_MS)),
        ]);
      } catch {
        connection.disconnect();
      }
    }
  }
}
