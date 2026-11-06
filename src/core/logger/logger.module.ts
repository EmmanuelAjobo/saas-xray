import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/config.service.js';
import { buildPinoHttpOptions } from './logger.config.js';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: buildPinoHttpOptions({
          level: config.get('LOG_LEVEL'),
          pretty: config.isDevelopment,
        }),
      }),
    }),
  ],
})
export class LoggerModule {}
