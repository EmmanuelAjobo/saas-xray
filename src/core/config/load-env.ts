import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env` into `process.env` for local development, using Node's built-in loader
 * (no dotenv dependency). Variables already set in the real environment always win, so
 * production hosts and CI are never overridden by a stray file.
 *
 * Must run before the Nest app is created. Not used in tests (see test/setup-env.ts).
 */
export function loadDotEnv(file = resolve(process.cwd(), '.env')): void {
  if (process.env.NODE_ENV === 'production') return;
  if (existsSync(file)) process.loadEnvFile(file);
}
