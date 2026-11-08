import { Injectable } from '@nestjs/common';
import {
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { RequestValidationException } from '../../common/errors/request-validation.exception.js';
import { INT4_MAX } from '../../common/limits.js';
import {
  decodeCursor,
  keysetFilter,
  keysetOrder,
  pageSize,
  toPage,
} from '../../common/pagination.js';
import { DAY_MS } from '../../common/time.js';
import { BackgroundTasks } from '../../core/background/background-tasks.service.js';
import { escapeLike } from '../../common/search.js';
import { AppConfigService } from '../../core/config/config.service.js';
import type { RequestTenant } from '../../core/context/request-context.service.js';
import { MailService } from '../../core/mail/mail.service.js';
import { invoiceSentTemplate } from '../../core/mail/templates.js';
import { TenantPrismaService } from '../../core/prisma/tenant-prisma.service.js';
import { emailEvent } from '../../core/xray/xray.events.js';
import { recordXrayStep } from '../../core/xray/xray.trace.js';
import type { InvoiceStatus } from '../../generated/prisma/client.js';
import type {
  CreateInvoiceDto,
  LineItemDto,
  ListInvoicesQueryDto,
  UpdateInvoiceDto,
} from './dto/invoice.dto.js';
import { invoiceNumber } from './invoice-number.js';

const CLIENT = { select: { id: true, name: true, email: true } } as const;
const BASE = {
  id: true,
  number: true,
  status: true,
  totalCents: true,
  currency: true,
  dueDate: true,
  createdAt: true,
  updatedAt: true,
} as const;
const SUMMARY_SELECT = {
  ...BASE,
  client: CLIENT,
  _count: { select: { lineItems: true } },
} as const;
const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  lineItems: {
    select: {
      id: true,
      description: true,
      quantity: true,
      unitPriceCents: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] as Array<{
      createdAt?: 'asc';
      id?: 'asc';
    }>,
  },
} as const;

const NOT_FOUND = 'Invoice not found.';

function presentSummary<T extends { _count: { lineItems: number } }>(row: T) {
  const { _count, ...rest } = row;
  return { ...rest, lineItemCount: _count.lineItems };
}

function presentDetail<
  T extends {
    _count: { lineItems: number };
    lineItems: Array<{
      id: string;
      description: string;
      quantity: number;
      unitPriceCents: number;
    }>;
  },
>(row: T) {
  const { _count, lineItems, ...rest } = row;
  return {
    ...rest,
    lineItemCount: _count.lineItems,
    lineItems: lineItems.map((item) => ({
      ...item,
      amountCents: item.quantity * item.unitPriceCents,
    })),
  };
}

/** "USD 1,234.50" style text for email. Never throws: an odd currency code falls back to plain text. */
function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** Plain data for the database: never spread a DTO instance into a query. */
const lineItemData = (item: LineItemDto) => ({
  description: item.description,
  quantity: item.quantity,
  unitPriceCents: item.unitPriceCents,
});

const fieldError = (field: string, message: string) =>
  new RequestValidationException([{ field, message }]);

/**
 * Invoices of the current organisation (tenant-scoped client only).
 *
 * Money is whole cents in 32-bit integers; every total is computed on the server from the
 * line items, never accepted from the client. Status changes are atomic claims
 * (`UPDATE ... WHERE status IN (...)`), so two simultaneous "send" clicks cannot both win.
 *
 *   DRAFT ──send──▶ SENT ──pay──▶ PAID          (SENT → OVERDUE is a scheduled job, later)
 *     │               └─void─▶ VOID
 *     └──void──▶ VOID
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly config: AppConfigService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
  ) {}

  private get db() {
    return this.tenantDb.client;
  }

  // ───────────────────────────── validation helpers ─────────────────────────────

  /** Server-side total. Rejects what a 32-bit cents column cannot hold. */
  private totalOf(items: readonly LineItemDto[]): number {
    const max = this.config.get('INVOICE_MAX_LINE_ITEMS');
    if (items.length > max) {
      throw fieldError(
        'items',
        `an invoice can have at most ${max} line items`,
      );
    }
    let total = 0;
    for (const item of items) {
      const amount = item.quantity * item.unitPriceCents;
      total += amount;
      if (amount > INT4_MAX || total > INT4_MAX) {
        throw fieldError('items', 'the invoice total is too large');
      }
    }
    return total;
  }

  private async assertClient(clientId: string): Promise<void> {
    const client = await this.db.client.findFirst({
      where: { id: clientId },
      select: { id: true },
    });
    if (!client) {
      throw fieldError('clientId', 'must be a client of this organization');
    }
  }

  /** Why a guarded update changed nothing: it does not exist, or it is in the wrong state. */
  private async explain(id: string, whatYouCannotDo: string): Promise<never> {
    const invoice = await this.db.invoice.findFirst({
      where: { id, deletedAt: null },
      select: { status: true },
    });
    if (!invoice) throw new NotFoundError(NOT_FOUND);
    throw new InvalidStateTransitionError(
      `${whatYouCannotDo} (this invoice is ${invoice.status}).`,
    );
  }

  // ───────────────────────────── create / read ─────────────────────────────

  async create(tenant: RequestTenant, dto: CreateInvoiceDto) {
    await this.assertClient(dto.clientId);
    const items = dto.items ?? [];
    const total = this.totalOf(items);

    const created = await this.db.$transaction(async (tx) => {
      // Atomic increment: concurrent creates get different numbers, and if this transaction
      // rolls back the number is released too, so the sequence has no gaps.
      const { invoiceSeq } = await tx.organization.update({
        where: { id: tenant.organizationId },
        data: { invoiceSeq: { increment: 1 } },
        select: { invoiceSeq: true },
      });
      return tx.invoice.create({
        data: {
          clientId: dto.clientId,
          number: invoiceNumber(invoiceSeq),
          totalCents: total,
          currency: dto.currency ?? this.config.get('INVOICE_DEFAULT_CURRENCY'),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          lineItems: { create: items.map(lineItemData) },
        } as never,
        select: DETAIL_SELECT,
      });
    });
    return presentDetail(created);
  }

  async list(query: ListInvoicesQueryDto) {
    const limit = pageSize(query.limit, {
      defaultSize: this.config.get('PAGE_SIZE_DEFAULT'),
      maxSize: this.config.get('PAGE_SIZE_MAX'),
    });
    const after = keysetFilter(
      'createdAt',
      'desc',
      decodeCursor(query.cursor),
      (raw) => {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          throw fieldError('cursor', 'is not a valid cursor');
        }
        return date;
      },
    );
    const rows = await this.db.invoice.findMany({
      where: {
        deletedAt: null,
        status: query.status,
        clientId: query.clientId,
        number: query.q
          ? { contains: escapeLike(query.q), mode: 'insensitive' }
          : undefined,
        AND: [after ?? {}],
      },
      orderBy: keysetOrder('createdAt', 'desc'),
      take: limit + 1,
      select: SUMMARY_SELECT,
    });
    const page = toPage(rows, limit, (row) => row.createdAt.toISOString());
    return { ...page, data: page.data.map(presentSummary) };
  }

  async get(id: string) {
    const row = await this.db.invoice.findFirst({
      where: { id, deletedAt: null },
      select: DETAIL_SELECT,
    });
    if (!row) throw new NotFoundError(NOT_FOUND);
    return presentDetail(row);
  }

  // ───────────────────────────── editing (DRAFT only) ─────────────────────────────

  async update(id: string, dto: UpdateInvoiceDto) {
    if (dto.clientId !== undefined) await this.assertClient(dto.clientId);
    const items = dto.items;
    const total = items === undefined ? undefined : this.totalOf(items);

    return this.db.$transaction(async (tx) => {
      // The guarded update is also the row lock: a concurrent edit or send waits here and
      // then sees the committed result.
      const claimed = await tx.invoice.updateMany({
        where: { id, status: 'DRAFT', deletedAt: null },
        data: {
          clientId: dto.clientId,
          currency: dto.currency,
          dueDate:
            dto.dueDate === undefined
              ? undefined
              : dto.dueDate === null
                ? null
                : new Date(dto.dueDate),
          totalCents: total,
        },
      });
      if (claimed.count === 0) {
        return this.explain(id, 'Only DRAFT invoices can be edited');
      }
      if (items !== undefined) {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
        if (items.length > 0) {
          await tx.invoiceLineItem.createMany({
            data: items.map((item) => ({
              invoiceId: id,
              ...lineItemData(item),
            })),
          });
        }
      }
      const row = await tx.invoice.findFirstOrThrow({
        where: { id },
        select: DETAIL_SELECT,
      });
      return presentDetail(row);
    });
  }

  /** Soft delete of a DRAFT. Anything that was ever sent is voided instead, never erased. */
  async remove(id: string): Promise<void> {
    const result = await this.db.invoice.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      await this.explain(
        id,
        'Only DRAFT invoices can be deleted; void it instead',
      );
    }
  }

  // ───────────────────────────── state transitions ─────────────────────────────

  /** DRAFT → SENT. Needs at least one line item and a positive total. Emails the client. */
  async send(id: string) {
    const sent = await this.db.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id, status: 'DRAFT', deletedAt: null },
        data: { status: 'SENT' },
      });
      if (claimed.count === 0) {
        return this.explain(id, 'Only DRAFT invoices can be sent');
      }
      const row = await tx.invoice.findFirstOrThrow({
        where: { id },
        select: {
          dueDate: true,
          totalCents: true,
          _count: { select: { lineItems: true } },
        },
      });
      if (row._count.lineItems === 0 || row.totalCents <= 0) {
        // Throwing rolls the status change back: the invoice stays a DRAFT.
        throw new InvalidStateTransitionError(
          'Add at least one line item with a price before sending.',
        );
      }
      if (!row.dueDate) {
        const terms = this.config.get('INVOICE_DEFAULT_TERMS_DAYS');
        await tx.invoice.update({
          where: { id },
          data: { dueDate: new Date(Date.now() + terms * DAY_MS) },
        });
      }
      return tx.invoice.findFirstOrThrow({
        where: { id },
        select: DETAIL_SELECT,
      });
    });

    await this.notifyClient(sent);
    return presentDetail(sent);
  }

  /** SENT or OVERDUE → PAID. */
  pay(id: string) {
    return this.transition(
      id,
      ['SENT', 'OVERDUE'],
      'PAID',
      'Only SENT or OVERDUE invoices can be marked paid',
    );
  }

  /** DRAFT, SENT or OVERDUE → VOID. A PAID invoice cannot be voided. */
  void(id: string) {
    return this.transition(
      id,
      ['DRAFT', 'SENT', 'OVERDUE'],
      'VOID',
      'Only unpaid invoices can be voided',
    );
  }

  private async transition(
    id: string,
    from: InvoiceStatus[],
    to: InvoiceStatus,
    refusal: string,
  ) {
    const claimed = await this.db.invoice.updateMany({
      where: { id, status: { in: from }, deletedAt: null },
      data: { status: to },
    });
    if (claimed.count === 0) await this.explain(id, refusal);
    return this.get(id);
  }

  // ───────────────────────────── email ─────────────────────────────

  /** Demo organisations never send real mail (ARCHITECTURE §18). Failures never fail the request. */
  private async notifyClient(invoice: {
    number: string;
    currency: string;
    totalCents: number;
    dueDate: Date | null;
    client: { name: string; email: string };
  }) {
    const org = await this.db.organization.findFirst({
      select: { name: true, isDemo: true },
    });
    if (!org) return;
    if (org.isDemo) {
      recordXrayStep(
        emailEvent({ ts: Date.now(), template: 'invoice-sent', sent: false }),
      );
      return;
    }
    const amount = formatMoney(invoice.totalCents, invoice.currency);
    this.background.run('invoice-sent-email', async () => {
      await this.mail.send({
        to: invoice.client.email,
        ...invoiceSentTemplate({
          organizationName: org.name,
          clientName: invoice.client.name,
          number: invoice.number,
          amount,
          dueDate: (invoice.dueDate ?? new Date()).toISOString().slice(0, 10),
        }),
      });
      // Only reached when delivery succeeded (a failure throws and is logged instead).
      recordXrayStep(
        emailEvent({ ts: Date.now(), template: 'invoice-sent', sent: true }),
      );
    });
  }
}
