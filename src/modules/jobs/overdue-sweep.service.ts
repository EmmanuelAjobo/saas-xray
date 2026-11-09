import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../core/config/config.service.js';
import { RequestContextService } from '../../core/context/request-context.service.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import { jobEvent } from '../../core/xray/xray.events.js';
import { XrayService } from '../../core/xray/xray.service.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { eventTime } from '../../core/xray/xray.clock.js';

/** The actor recorded for work done by the system rather than by a person. */
const SYSTEM_MEMBERSHIP = 'system';

export interface SweepResult {
  organizations: number;
  invoices: number;
}

/**
 * Marks past-due SENT invoices as OVERDUE, across every organisation, on a schedule.
 *
 * Finding WHICH organisations have something to do is the one cross-tenant read, so it uses
 * the unscoped client (this is a job, not a domain module). The change itself is made
 * through the tenant-scoped invoice service, once per organisation, inside that
 * organisation's own tenant context: the sweep cannot touch an organisation it is not
 * currently "inside". Safe to run twice (it only ever moves SENT to OVERDUE) and by two
 * instances at once.
 */
@Injectable()
export class OverdueSweepService {
  private readonly logger = new Logger(OverdueSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly context: RequestContextService,
    private readonly xray: XrayService,
    private readonly config: AppConfigService,
  ) {}

  async run(now = new Date()): Promise<SweepResult> {
    const due = await this.prisma.invoice.groupBy({
      by: ['organizationId'],
      where: { status: 'SENT', deletedAt: null, dueDate: { lt: now } },
      orderBy: { organizationId: 'asc' },
      // Organisations handled per run; the rest are picked up by the next run (the ones
      // done here no longer match, so the next run moves on to the following ones).
      take: this.config.get('OVERDUE_SWEEP_ORG_BATCH'),
    });

    const result: SweepResult = { organizations: 0, invoices: 0 };
    for (const { organizationId } of due) {
      try {
        const marked = await this.context.runWithTenant(
          { organizationId, membershipId: SYSTEM_MEMBERSHIP, role: 'OWNER' },
          () => this.invoices.markOverdue(now),
        );
        if (marked === 0) continue;
        result.organizations += 1;
        result.invoices += marked;
        this.xray.publish(organizationId, [
          jobEvent({
            ts: eventTime(),
            label: 'overdue invoice sweep',
            phase: 'completed',
            detail: `${marked} invoice${marked === 1 ? '' : 's'} marked overdue`,
          }),
        ]);
      } catch (error) {
        // One organisation's problem must not stop the others.
        this.logger.error(
          `Overdue sweep failed for one organisation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return result;
  }
}
