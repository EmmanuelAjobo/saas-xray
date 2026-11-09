import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { safeErrorMessage } from '../../common/redact.js';

/**
 * Runs work after the HTTP response is decided, without letting a failure reach the caller.
 *
 * Why it exists: sending an email must never make a request slower, fail it, or (worse)
 * make "forgot password" take measurably longer for accounts that exist, which would leak
 * which emails are registered. Milestone 10 replaces this with real queue jobs (BullMQ,
 * retries, back-off); callers will not change.
 *
 * Tasks are tracked so shutdown and tests can wait for them (`drain`).
 */
@Injectable()
export class BackgroundTasks implements OnModuleDestroy {
  private readonly logger = new Logger(BackgroundTasks.name);
  private readonly pending = new Set<Promise<void>>();

  run(name: string, task: () => Promise<unknown>): void {
    const tracked = (async () => {
      try {
        await task();
      } catch (error) {
        // Log the cause, never the payload: tasks may carry tokens or addresses.
        this.logger.error(
          `Background task "${name}" failed: ${safeErrorMessage(error)}`,
        );
      }
    })().finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Resolves when everything started so far (and anything it started) has finished. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }
}
