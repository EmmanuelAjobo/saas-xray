-- Sort client names the way people expect: "alpha" before "Charlie", not after "Zed".
--
-- The Postgres image used in development (Alpine/musl) has no locale-aware collation, so
-- plain text columns sort by raw bytes (all capitals before all lower-case). The ICU "und"
-- collation gives a language-neutral, case-insensitive-first ordering everywhere.
-- Prisma's schema language cannot express a column collation, so it is set here by hand,
-- like the CHECK constraints in the first migration. The (organizationId, name) index is
-- rebuilt automatically by this ALTER, and keyset pagination uses the same collation.
ALTER TABLE "Client" ALTER COLUMN "name" TYPE TEXT COLLATE "und-x-icu";
