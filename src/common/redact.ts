/**
 * Hides email addresses in text that is about to be logged. Mail providers often echo the
 * recipient in an error ("550 rejected jane@client.com"), and a log line should say what
 * went wrong, not who the customer is.
 */
const EMAIL = /[^\s<>()"',;:@]+@[^\s<>()"',;:@]+\.[^\s<>()"',;:@]+/g;

export function redactEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/** The message of a thrown value, safe to log. */
export function safeErrorMessage(error: unknown): string {
  return redactEmails(error instanceof Error ? error.message : String(error));
}
