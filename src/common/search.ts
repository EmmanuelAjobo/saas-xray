/**
 * Makes a user's search text literal inside a SQL `LIKE`/`ILIKE` pattern.
 *
 * Prisma's `contains` wraps the text in `%...%` but does not escape what is inside, so a
 * search for "100%" would treat "%" as "match anything" and "_" as "any one character".
 * Backslash is Postgres's default LIKE escape character, so `\%`, `\_` and `\\` mean the
 * literal characters.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}
