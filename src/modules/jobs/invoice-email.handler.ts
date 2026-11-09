import { Injectable } from '@nestjs/common';
import { MailService } from '../../core/mail/mail.service.js';
import { invoiceSentTemplate } from '../../core/mail/templates.js';
import type { InvoiceEmailJob } from '../../core/jobs/jobs.types.js';
import { emailEvent } from '../../core/xray/xray.events.js';
import { XrayService } from '../../core/xray/xray.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { eventTime } from '../../core/xray/xray.clock.js';

/**
 * Sends (or, for a demo sandbox, captures) the "your invoice was sent" email. Runs in the
 * worker, after the click's response has gone out.
 *
 * A failure to deliver THROWS, so the queue retries with back-off. A demo's Outbox capture
 * never throws (a display feature must not fail a job).
 */
@Injectable()
export class InvoiceEmailHandler {
  constructor(
    private readonly mail: MailService,
    private readonly outbox: OutboxService,
    private readonly xray: XrayService,
  ) {}

  async handle(job: InvoiceEmailJob): Promise<void> {
    const email = invoiceSentTemplate({
      organizationName: job.organizationName,
      clientName: job.clientName,
      number: job.number,
      amount: job.amount,
      dueDate: job.dueDate,
    });

    if (job.delivery === 'outbox') {
      await this.outbox.capture(job.organizationId, {
        to: job.to,
        subject: email.subject,
        text: email.text,
      });
    } else {
      await this.mail.send({ to: job.to, ...email });
    }

    // Only reached when it worked. Tell the organisation's X-ray, joined to the click.
    this.xray.publish(job.organizationId, [
      emailEvent({
        ts: eventTime(),
        template: 'invoice-sent',
        outcome: job.delivery === 'outbox' ? 'captured' : 'sent',
        ...(job.requestId ? { requestId: job.requestId } : {}),
      }),
    ]);
  }
}
