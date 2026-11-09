import { eventTime } from './xray.clock.js';

describe('eventTime', () => {
  it('is epoch milliseconds, close to Date.now()', () => {
    expect(Math.abs(eventTime() - Date.now())).toBeLessThan(50);
  });

  it('never goes backwards, and distinguishes events inside the same millisecond', () => {
    const times = Array.from({ length: 2_000 }, () => eventTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1] as number);
    }
    // Far more distinct values than whole milliseconds that passed.
    const wholeMs = new Set(times.map(Math.floor)).size;
    expect(new Set(times).size).toBeGreaterThan(wholeMs);
  });
});
