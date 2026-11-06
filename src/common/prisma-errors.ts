/**
 * Prisma errors are matched by their code rather than by class, so common/ does not depend on
 * the generated client. P2002 unique constraint, P2003 foreign key, P2025 record not found.
 */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PrismaClientKnownRequestError'
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

export const isUniqueViolation = (error: unknown): boolean =>
  codeOf(error) === 'P2002';
export const isForeignKeyViolation = (error: unknown): boolean =>
  codeOf(error) === 'P2003';
export const isRecordNotFound = (error: unknown): boolean =>
  codeOf(error) === 'P2025';
