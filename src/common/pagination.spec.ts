import { RequestValidationException } from './errors/request-validation.exception.js';
import {
  decodeCursor,
  encodeCursor,
  keysetFilter,
  keysetOrder,
  pageSize,
  toPage,
} from './pagination.js';

const ID = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

describe('cursor', () => {
  it('round-trips, including unusual values', () => {
    for (const value of [
      'Acme',
      '',
      'Zoë & "quotes" 🚀',
      '2026-01-01T00:00:00.000Z',
    ]) {
      expect(decodeCursor(encodeCursor({ value, id: ID }))).toEqual({
        value,
        id: ID,
      });
    }
  });

  it('is opaque and URL-safe', () => {
    const cursor = encodeCursor({ value: 'Acme', id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('Acme');
  });

  it('no cursor means the first page', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it.each([
    ['garbage', '!!!not-base64!!!'],
    ['empty', ''],
    ['not JSON', Buffer.from('hello').toString('base64url')],
    ['wrong shape (object)', Buffer.from('{"a":1}').toString('base64url')],
    ['wrong length', Buffer.from(JSON.stringify(['a'])).toString('base64url')],
    [
      'non-string value',
      Buffer.from(JSON.stringify([1, ID])).toString('base64url'),
    ],
    [
      'id is not a UUID',
      Buffer.from(JSON.stringify(['a', "' OR 1=1"])).toString('base64url'),
    ],
    [
      'too many parts',
      Buffer.from(JSON.stringify(['a', ID, 'x'])).toString('base64url'),
    ],
  ])(
    'rejects %s with a 400 validation error naming the field',
    (_label, raw) => {
      try {
        decodeCursor(raw);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RequestValidationException);
        expect((error as RequestValidationException).errors).toEqual([
          { field: 'cursor', message: 'is not a valid cursor' },
        ]);
      }
    },
  );
});

describe('keyset filter and order', () => {
  it('continues AFTER the cursor row in ascending order', () => {
    expect(keysetFilter('name', 'asc', { value: 'Bo', id: ID })).toEqual({
      OR: [{ name: { gt: 'Bo' } }, { name: 'Bo', id: { gt: ID } }],
    });
  });

  it('continues after the cursor row in descending order', () => {
    expect(
      keysetFilter('createdAt', 'desc', { value: 'x', id: ID }, () => 42),
    ).toEqual({
      OR: [{ createdAt: { lt: 42 } }, { createdAt: 42, id: { lt: ID } }],
    });
  });

  it('adds nothing without a cursor', () => {
    expect(keysetFilter('name', 'asc', undefined)).toBeUndefined();
  });

  it('orders by the field, then id (a total order, so no ties)', () => {
    expect(keysetOrder('name', 'asc')).toEqual([
      { name: 'asc' },
      { id: 'asc' },
    ]);
  });
});

describe('pageSize', () => {
  const limits = { defaultSize: 20, maxSize: 100 };
  it.each([
    [undefined, 20],
    [5, 5],
    [100, 100],
    [101, 100],
    [100000, 100],
    [0, 1],
    [-4, 1],
  ])('requested %s → %s', (requested, expected) => {
    expect(pageSize(requested, limits)).toBe(expected);
  });
});

describe('toPage', () => {
  const rows = Array.from({ length: 6 }, (_u, i) => ({
    id: `0198a2b4-5d6e-7f80-9a1b-00000000000${i}`,
    n: `row${i}`,
  }));

  it('gives a cursor for the last returned row when there are more', () => {
    const page = toPage(rows.slice(0, 4), 3, (r) => r.n); // 4 fetched, limit 3
    expect(page.data).toHaveLength(3);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({
      value: 'row2',
      id: rows[2]!.id,
    });
  });

  it('has no cursor on the last page, exactly full or not', () => {
    expect(toPage(rows.slice(0, 3), 3, (r) => r.n).nextCursor).toBeNull();
    expect(toPage(rows.slice(0, 2), 3, (r) => r.n).nextCursor).toBeNull();
    expect(toPage([], 3, (r: { id: string; n: string }) => r.n)).toEqual({
      data: [],
      nextCursor: null,
    });
  });
});
