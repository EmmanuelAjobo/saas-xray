import { Global, Module } from '@nestjs/common';
import { OutboxController } from './outbox.controller.js';
import { OutboxService } from './outbox.service.js';
import { OUTBOX_STORE } from './outbox.types.js';
import { RedisOutboxStore } from './redis-outbox.store.js';

/**
 * The demo's mail outbox. Global so the invoice service can capture an email without a
 * module import; the endpoint that shows it is the controller here.
 */
@Global()
@Module({
  controllers: [OutboxController],
  providers: [
    RedisOutboxStore,
    { provide: OUTBOX_STORE, useExisting: RedisOutboxStore },
    OutboxService,
  ],
  exports: [OutboxService, OUTBOX_STORE],
})
export class OutboxModule {}
