import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { TenantPrismaService } from './tenant-prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, TenantPrismaService],
  exports: [PrismaService, TenantPrismaService],
})
export class PrismaModule {}
