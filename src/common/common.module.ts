import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { GlobalExceptionFilter } from './filters/global-exception.filter.js';
import { TimeoutInterceptor } from './interceptors/timeout.interceptor.js';
import { createValidationPipe } from './pipes/validation.pipe.js';

/**
 * App-wide request pipeline pieces, registered through DI (APP_*) rather than in main.ts,
 * so they are also active in tests that build the app from AppModule.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
  ],
})
export class CommonModule {}
