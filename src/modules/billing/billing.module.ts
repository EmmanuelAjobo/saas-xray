import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service.js';

@Module({
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class BillingModule {}
