import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core/config/config.service.js';
import type { OutboxMessage, OutboxStore } from './outbox.types.js';

/** Keeps messages in this process only. For tests, where no Redis is wanted. */
@Injectable()
export class MemoryOutboxStore implements OutboxStore {
  private readonly messages = new Map<string, OutboxMessage[]>();

  constructor(private readonly config: AppConfigService) {}

  add(organizationId: string, message: OutboxMessage): Promise<void> {
    const kept = [message, ...(this.messages.get(organizationId) ?? [])].slice(
      0,
      this.config.get('OUTBOX_MAX_MESSAGES'),
    );
    this.messages.set(organizationId, kept);
    return Promise.resolve();
  }

  list(organizationId: string, limit: number): Promise<OutboxMessage[]> {
    return Promise.resolve(
      (this.messages.get(organizationId) ?? []).slice(0, limit),
    );
  }
}
