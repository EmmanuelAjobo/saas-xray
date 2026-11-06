/**
 * These are programming errors, not user errors, so they are deliberately NOT domain errors:
 * the error filter answers them with a generic 500 and logs the detail. A client can never
 * trigger one by sending a strange request; only a bug in our own code can.
 */

/** A query on tenant data ran with no organisation in the request context. */
export class TenantContextMissingError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Tenant-scoped query ${model}.${operation} ran without an organisation in context. ` +
        'Tenant routes get one from TenantGuard; background work must use runWithTenant().',
    );
    this.name = 'TenantContextMissingError';
  }
}

/** Code tried to read or write across the tenant boundary through the scoped client. */
export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantViolationError';
  }
}
