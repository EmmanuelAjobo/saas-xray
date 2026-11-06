import { execFileSync } from 'node:child_process';
import { testDatabaseUrl } from './test-database-url.js';

/** Runs once before the integration suite: brings the test database up to the latest migration. */
export default function setup(): void {
  const url = testDatabaseUrl();
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (error) {
    const output =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new Error(
      'Could not migrate the test database. Is Docker running? ' +
        `Try: docker compose up -d --wait\n${output}`,
      { cause: error },
    );
  }
}
