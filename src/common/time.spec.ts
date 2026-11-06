import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  formatDuration,
} from './time.js';

describe('time units', () => {
  it('are consistent with each other', () => {
    expect(SECOND_MS).toBe(1000);
    expect(MINUTE_MS).toBe(60 * SECOND_MS);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});

describe('formatDuration', () => {
  it.each([
    [HOUR_MS, '1 hour'],
    [24 * HOUR_MS, '1 day'],
    [48 * HOUR_MS, '2 days'],
    [36 * HOUR_MS, '36 hours'],
    [30 * MINUTE_MS, '30 minutes'],
    [MINUTE_MS, '1 minute'],
    [90 * MINUTE_MS, '90 minutes'],
    [45 * SECOND_MS, '45 seconds'],
  ])('%d ms is "%s"', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
