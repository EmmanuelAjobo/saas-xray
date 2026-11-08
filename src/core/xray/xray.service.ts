import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import type { NewXrayEvent } from './xray.events.js';
import { XRAY_STORE, type XrayStore } from './xray.store.js';

/**
 * Publishes X-ray events to an organisation's stream.
 *
 * Fire-and-forget by design: publishing never delays a response and never throws. If Redis
 * is down the events are lost and one warning is logged; the request that caused them is
 * unaffected. (X-ray is a window into the backend, not part of it.)
 */
@Injectable()
export class XrayService {
  private readonly logger = new Logger(XrayService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(XRAY_STORE) private readonly store: XrayStore,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get('XRAY_ENABLED');
  }

  /**
   * `organizationId` must come from a VERIFIED membership (the tenant guard's result),
   * never from a path parameter or body: it decides whose stream the events appear in.
   */
  publish(organizationId: string, events: NewXrayEvent[]): void {
    if (!this.enabled || events.length === 0) return;
    const task = this.store
      .append(organizationId, events)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not publish X-ray events: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Resolves when everything published so far has been written. For tests and shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }
}
