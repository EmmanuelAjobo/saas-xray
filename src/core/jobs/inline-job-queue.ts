import { Injectable } from '@nestjs/common';
import { BackgroundTasks } from '../background/background-tasks.service.js';
import { AppConfigService } from '../config/config.service.js';
import { JobRunner } from './job-runner.service.js';
import type { JobData, JobName, JobQueue } from './jobs.types.js';

/**
 * Runs a job in this process, right away, with the same number of attempts as the real
 * queue (but no waiting between them). For tests, where no Redis is wanted. It goes through
 * BackgroundTasks, so a test can `drain()` to wait for the work to finish.
 */
@Injectable()
export class InlineJobQueue implements JobQueue {
  constructor(
    private readonly runner: JobRunner,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
  ) {}

  add<N extends JobName>(name: N, data: JobData[N]): Promise<void> {
    const attempts = this.config.get('EMAIL_JOB_ATTEMPTS');
    this.background.run(`job:${name}`, async () => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await this.runner.execute(name, data, { attempt, attempts });
          return;
        } catch {
          // The runner has logged it and told the X-ray; try again, or give up after the last.
        }
      }
    });
    return Promise.resolve();
  }
}
