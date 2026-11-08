import { daysUntil, formatClock, formatMoney, sentenceCase } from './format.js';

describe('formatMoney', () => {
  it('shows whole cents as currency', () => {
    expect(formatMoney(98600, 'USD')).toBe('$986.00');
    expect(formatMoney(5, 'USD')).toBe('$0.05');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });
  it('never throws on an unknown currency code', () => {
    expect(formatMoney(1250, 'ZZZZ')).toBe('ZZZZ 12.50');
  });
});

describe('sentenceCase', () => {
  it('capitalises the first letter only', () => {
    expect(sentenceCase('SENT')).toBe('Sent');
    expect(sentenceCase('overdue')).toBe('Overdue');
  });
});

describe('daysUntil', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  it('counts whole days ahead and behind', () => {
    expect(daysUntil('2026-11-18T12:00:00Z', now)).toBe(10);
    expect(daysUntil('2026-11-05T12:00:00Z', now)).toBe(-3);
  });
  it('is null when there is no date', () => {
    expect(daysUntil(null, now)).toBeNull();
  });
});

describe('formatClock', () => {
  it('formats as a 24-hour clock', () => {
    expect(formatClock(0)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
