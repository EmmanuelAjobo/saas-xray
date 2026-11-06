import { Inject, Injectable } from '@nestjs/common';
import type { Env } from './env.schema.js';

export const ENV = Symbol('ENV');

/** Typed, read-only access to the validated environment. */
@Injectable()
export class AppConfigService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isDevelopment(): boolean {
    return this.env.NODE_ENV === 'development';
  }
}
