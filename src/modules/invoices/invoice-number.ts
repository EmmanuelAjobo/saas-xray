import { INVOICE_NUMBER_PAD } from '../../common/limits.js';

/** 7 → "INV-0007". Unique per organisation, generated from its own counter. */
export function invoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(INVOICE_NUMBER_PAD, '0')}`;
}
