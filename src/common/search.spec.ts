import { escapeLike } from './search.js';

describe('escapeLike', () => {
  it.each([
    ['plain', 'plain'],
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['%_%', '\\%\\_\\%'],
    ['back\\slash', 'back\\\\slash'],
    ['\\%', '\\\\\\%'],
    ['', ''],
    ["O'Brien", "O'Brien"], // quotes are handled by parameter binding, not by escaping
  ])('%j → %j', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });

  it('never leaves a lone wildcard behind', () => {
    const escaped = escapeLike('50%_off\\now');
    expect(escaped.replace(/\\[\\%_]/g, '')).not.toMatch(/[%_\\]/);
  });
});
