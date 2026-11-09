import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import { EMAIL_MAX_LENGTH } from '../../common/limits.js';
import { AppConfigService } from '../../core/config/config.service.js';
import { RequestContextService } from '../../core/context/request-context.service.js';
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from './outbox.limits.js';
import {
  type NewOutboxMessage,
  OUTBOX_STORE,
  type OutboxMessage,
  type OutboxStore,
} from './outbox.types.js';

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The demo's mail outbox. A demo sandbox never sends real email (anyone can click the demo
 * button), so what it WOULD have sent is captured here and shown on the page: the visitor
 * sees the email the client would have received, with no mail provider involved.
 *
 * Real organisations have no outbox: their mail is really delivered.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(OUTBOX_STORE) private readonly store: OutboxStore,
    private readonly config: AppConfigService,
    private readonly context: RequestContextService,
  ) {}

  /**
   * Keeps an email in a DEMO organisation's outbox. Never throws: a Redis hiccup must not
   * fail the invoice that was just sent; the email simply is not shown.
   * `organizationId` must come from the verified tenant, never from the caller's input.
   */
  async capture(
    organizationId: string,
    message: NewOutboxMessage,
  ): Promise<void> {
    try {
      await this.store.add(organizationId, {
        id: randomUUID(),
        ts: Date.now(),
        to: cut(message.to, EMAIL_MAX_LENGTH),
        subject: cut(message.subject, MAX_SUBJECT_LENGTH),
        text: cut(message.text, MAX_BODY_LENGTH),
      });
    } catch (error) {
      this.logger.warn(
        `Could not capture an outbox email: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The caller's own organisation's captured emails, newest first. Demo sandboxes only. */
  async list(): Promise<{ data: OutboxMessage[] }> {
    const auth = this.context.auth;
    const tenant = this.context.tenant;
    // A real organisation has no outbox (its email is really sent): same answer as for any
    // other thing that does not exist.
    if (!auth || !tenant || !auth.isDemo) {
      throw new NotFoundError('There is no outbox here.');
    }
    return {
      data: await this.store.list(
        tenant.organizationId,
        this.config.get('OUTBOX_MAX_MESSAGES'),
      ),
    };
  }
}
