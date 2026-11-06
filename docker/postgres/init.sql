-- Runs once, the first time the postgres volume is created.
-- The app database (saas_xray) is created by POSTGRES_DB; this adds the one used by tests,
-- so running the test suite can never touch development data.
CREATE DATABASE saas_xray_test;
