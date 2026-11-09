import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { BullMqJobQueue } from './bullmq-job-queue.js';
import { JobRunner } from './job-runner.service.js';
import { JobsService } from './jobs.service.js';
import { JOB_QUEUE } from './jobs.types.js';

/**
 * Background jobs: the queue (Redis via BullMQ), the runner that narrates each attempt to
 * the X-ray, and the service the rest of the app queues work through. Global, like the
 * X-ray: any service can queue a job without importing this module.
 *
 * The queue is built by a factory (not a class provider) so tests can replace it with the
 * in-process one without BullMQ ever opening a Redis connection.
 */
@Global()
@Module({
  providers: [
    JobRunner,
    {
      provide: JOB_QUEUE,
      inject: [AppConfigService, JobRunner],
      useFactory: (config: AppConfigService, runner: JobRunner) =>
        new BullMqJobQueue(config, runner),
    },
    JobsService,
  ],
  exports: [JobsService, JobRunner, JOB_QUEUE],
})
export class JobsModule {}
