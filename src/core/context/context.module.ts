import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { getRequestIdFromRequest } from './request-id.js';
import { RequestContextService } from './request-context.service.js';

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req) => getRequestIdFromRequest(req),
      },
    }),
  ],
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class ContextModule {}
