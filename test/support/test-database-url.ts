const DEFAULT_URL =
  'postgresql://postgres:postgres@localhost:5433/saas_xray_test';

/**
 * The database integration tests run against, and wipe between tests.
 *
 * Safety: the database name must end in `_test`. A mistyped TEST_DATABASE_URL (or a stray
 * DATABASE_URL) pointing at development or production data fails here, before anything is
 * truncated.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${databaseName}": ` +
        'the test database name must end with "_test".',
    );
  }
  return url;
}
