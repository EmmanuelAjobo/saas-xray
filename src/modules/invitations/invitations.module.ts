import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { OrgInvitationsController } from './org-invitations.controller.js';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [OrgInvitationsController, InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
