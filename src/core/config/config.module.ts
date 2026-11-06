import { Global, Module } from '@nestjs/common';
import { AppConfigService, ENV } from './config.service.js';
import { validateEnv } from './env.schema.js';

@Global()
@Module({
  providers: [
    // Throws EnvValidationError during bootstrap if the environment is invalid.
    { provide: ENV, useFactory: () => validateEnv(process.env) },
    AppConfigService,
  ],
  exports: [AppConfigService],
})
export class ConfigModule {}
