import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import type { NewXrayEvent, XrayEvent } from './xray.events.js';
import { type XrayStore, compareStreamIds } from './xray.store.js';

/**
 * Keeps events in this process only. For tests, where no Redis is wanted. It follows the
 * same rules as the Redis store (bounded per organisation, strictly increasing ids, live
 * listeners) so tests of the layers above exercise realistic behaviour.
 */
@Injectable()
export class MemoryXrayStore implements XrayStore {
  private readonly events = new Map<string, XrayEvent[]>();
  private readonly listeners = new Map<
    string,
    Set<(event: XrayEvent) => void>
  >();
  private lastMs = 0;
  private lastSeq = 0;

  constructor(private readonly config: AppConfigService) {}

  private nextId(): string {
    const now = Date.now();
    if (now > this.lastMs) {
      this.lastMs = now;
      this.lastSeq = 0;
    } else {
      this.lastSeq += 1;
    }
    return `${this.lastMs}-${this.lastSeq}`;
  }

  append(organizationId: string, events: NewXrayEvent[]): Promise<XrayEvent[]> {
    const stored = events.map((event) => ({ ...event, id: this.nextId() }));
    const kept = [...(this.events.get(organizationId) ?? []), ...stored].slice(
      -this.config.get('XRAY_BUFFER_SIZE'),
    );
    this.events.set(organizationId, kept);
    for (const event of stored) {
      for (const listener of this.listeners.get(organizationId) ?? []) {
        try {
          listener(event);
        } catch {
          // One broken listener must not stop the others.
        }
      }
    }
    return Promise.resolve(stored);
  }

  latest(organizationId: string, limit: number): Promise<XrayEvent[]> {
    return Promise.resolve(
      (this.events.get(organizationId) ?? []).slice(-limit),
    );
  }

  after(
    organizationId: string,
    afterId: string,
    limit: number,
  ): Promise<XrayEvent[]> {
    return Promise.resolve(
      (this.events.get(organizationId) ?? [])
        .filter((event) => compareStreamIds(event.id, afterId) > 0)
        .slice(0, limit),
    );
  }

  subscribe(
    organizationId: string,
    listener: (event: XrayEvent) => void,
  ): Promise<() => Promise<void>> {
    const set = this.listeners.get(organizationId) ?? new Set();
    set.add(listener);
    this.listeners.set(organizationId, set);
    return Promise.resolve(() => {
      set.delete(listener);
      return Promise.resolve();
    });
  }

  /** Test helper: how many listeners are attached (to prove streams clean up). */
  listenerCount(organizationId: string): number {
    return this.listeners.get(organizationId)?.size ?? 0;
  }
}
