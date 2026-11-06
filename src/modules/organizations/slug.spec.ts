import { SLUG_BASE_MAX_LENGTH } from '../../common/limits.js';
import { makeSlug, slugBase } from './slug.js';

const VALID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('slugBase', () => {
  it.each([
    ['Acme Studio', 'acme-studio'],
    ['  Acme   Studio  ', 'acme-studio'],
    ['Acme Studio, Inc.', 'acme-studio-inc'],
    ['ÉCOLE d’été', 'ecole-d-ete'],
    ['Müller & Söhne', 'muller-sohne'],
    ['a/b\\c?d=e', 'a-b-c-d-e'],
    ['--leading and trailing--', 'leading-and-trailing'],
  ])('%j becomes %j', (name, expected) => {
    expect(slugBase(name)).toBe(expected);
  });

  it.each(['', '   ', '!!!', '密码', '🚀🚀'])(
    'falls back to "org" when nothing usable is left (%j)',
    (name) => {
      expect(slugBase(name)).toBe('org');
    },
  );

  it('caps the readable part and never ends in a dash after cutting', () => {
    const base = slugBase('word '.repeat(50));
    expect(base.length).toBeLessThanOrEqual(SLUG_BASE_MAX_LENGTH);
    expect(base).not.toMatch(/-$/);
    expect(base).toMatch(VALID_SLUG);
  });

  it('cannot be tricked into path or markup characters', () => {
    expect(slugBase('../../etc/passwd')).toBe('etc-passwd');
    expect(slugBase('<script>alert(1)</script>')).toBe('script-alert-1-script');
  });
});

describe('makeSlug', () => {
  it('is URL-safe and ends in a 6-character hex suffix', () => {
    expect(makeSlug('Acme Studio')).toMatch(/^acme-studio-[0-9a-f]{6}$/);
    expect(makeSlug('密码')).toMatch(/^org-[0-9a-f]{6}$/);
    expect(makeSlug('x'.repeat(500))).toMatch(VALID_SLUG);
  });

  it('gives two organisations with the same name different slugs', () => {
    const slugs = new Set(Array.from({ length: 200 }, () => makeSlug('Acme')));
    expect(slugs.size).toBeGreaterThan(195);
  });
});
