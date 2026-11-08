import {
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { RedisXrayStore } from './redis-xray.store.js';
import { XrayMiddleware } from './xray.middleware.js';
import { XrayService } from './xray.service.js';
import { XRAY_STORE } from './xray.store.js';

/**
 * The X-ray plumbing: the store (Redis Streams), the publisher, and the middleware that
 * records every request. Global so guards and services can record steps without importing
 * this module. The reading side (endpoints) is `modules/xray`.
 */
@Global()
@Module({
  providers: [
    RedisXrayStore,
    { provide: XRAY_STORE, useExisting: RedisXrayStore },
    XrayService,
    XrayMiddleware,
  ],
  exports: [XrayService, XRAY_STORE],
})
export class XrayCoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(XrayMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
