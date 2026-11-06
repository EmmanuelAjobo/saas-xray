import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { BackgroundModule } from './core/background/background.module.js';
import { ConfigModule } from './core/config/config.module.js';
import { ContextModule } from './core/context/context.module.js';
import { HealthModule } from './core/health/health.module.js';
import { LoggerModule } from './core/logger/logger.module.js';
import { MailModule } from './core/mail/mail.module.js';
import { PrismaModule } from './core/prisma/prisma.module.js';
import { RateLimitModule } from './core/rate-limit/rate-limit.module.js';
import { RedisModule } from './core/redis/redis.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ClientsModule } from './modules/clients/clients.module.js';
import { InvitationsModule } from './modules/invitations/invitations.module.js';
import { InvoicesModule } from './modules/invoices/invoices.module.js';
import { MembershipsModule } from './modules/memberships/memberships.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';

@Module({
  imports: [
    // Core: global, cross-cutting providers. Config first: everything else reads it.
    ConfigModule,
    ContextModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    BackgroundModule,
    MailModule,
    // Request pipeline: error filter, validation, timeout.
    CommonModule,
    // Guards run in this order: rate limit first (cheap rejection), then authentication.
    RateLimitModule,
    // Authentication, then tenancy: guards run in the order their modules are listed
    // (rate limit → authenticate → membership → permission).
    AuthModule,
    TenancyModule,
    // Features.
    OrganizationsModule,
    MembershipsModule,
    InvitationsModule,
    ClientsModule,
    TasksModule,
    InvoicesModule,
    HealthModule,
  ],
})
export class AppModule {}
