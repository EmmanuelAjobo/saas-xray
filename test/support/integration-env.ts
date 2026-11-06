import '../setup-env.js';
import { testDatabaseUrl } from './test-database-url.js';

// Every integration test file talks to the test database, never the development one.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.LOG_LEVEL ??= 'silent';
