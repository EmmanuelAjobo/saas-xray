import { Module } from '@nestjs/common';
import { JobRunner } from '../../core/jobs/job-runner.service.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { InvoiceEmailHandler } from './invoice-email.handler.js';
import { OverdueSweepService } from './overdue-sweep.service.js';

/**
 * What each background job DOES. Registered with the runner when the app is built (in the
 * constructor, not a start-up hook), so by the time the worker starts taking jobs from Redis
 * every handler is already in place.
 */
@Module({
  imports: [InvoicesModule],
  providers: [InvoiceEmailHandler, OverdueSweepService],
})
export class JobsHandlersModule {
  constructor(
    runner: JobRunner,
    emails: InvoiceEmailHandler,
    sweep: OverdueSweepService,
  ) {
    runner.register('invoice-email', (job) => emails.handle(job));
    runner.register('overdue-sweep', async () => {
      await sweep.run();
    });
  }
}
