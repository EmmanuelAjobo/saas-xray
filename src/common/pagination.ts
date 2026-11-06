import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RequestValidationException } from './errors/request-validation.exception.js';
import { CURSOR_MAX_LENGTH } from './limits.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?limit=20&cursor=...` on every list endpoint. The size ceiling is a setting (PAGE_SIZE_MAX). */
export class PageQueryDto {
  @ApiPropertyOptional({
    description: 'Items per page. Capped by the server (PAGE_SIZE_MAX).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque value from the previous page’s nextCursor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CURSOR_MAX_LENGTH)
  cursor?: string;
}

export interface Page<T> {
  data: T[];
  /** Pass as `cursor` for the next page; null when this was the last one. */
  nextCursor: string | null;
}

/**
 * A position in a sorted list: the value of the sort column plus the row id as a tie-breaker.
 * Keyset pagination (continue AFTER this row) rather than offsets, so rows inserted or
 * deleted between requests never cause duplicates or skips, and deep pages stay fast.
 */
export interface Cursor {
  value: string;
  id: string;
}

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify([cursor.value, cursor.id])).toString('base64url');

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return undefined;
  const invalid = () =>
    new RequestValidationException([
      { field: 'cursor', message: 'is not a valid cursor' },
    ]);
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      UUID.test(parsed[1])
    ) {
      return { value: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the same error as any other malformed cursor
  }
  throw invalid();
}

/** The `where` fragment for "everything after this cursor" in the given sort direction. */
export function keysetFilter(
  field: string,
  direction: 'asc' | 'desc',
  cursor: Cursor | undefined,
  parseValue: (raw: string) => unknown = (raw) => raw,
): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  const op = direction === 'asc' ? 'gt' : 'lt';
  const value = parseValue(cursor.value);
  return {
    OR: [
      { [field]: { [op]: value } },
      { [field]: value, id: { [op]: cursor.id } },
    ],
  };
}

export const keysetOrder = (field: string, direction: 'asc' | 'desc') => [
  { [field]: direction },
  { id: direction },
];

/** `limit` is clamped into [1, max]; undefined uses the default. */
export function pageSize(
  requested: number | undefined,
  { defaultSize, maxSize }: { defaultSize: number; maxSize: number },
): number {
  return Math.min(Math.max(requested ?? defaultSize, 1), maxSize);
}

/** Turns `limit + 1` fetched rows into a page, with a cursor if there are more. */
export function toPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  cursorValue: (row: T) => string,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    nextCursor:
      hasMore && last
        ? encodeCursor({ value: cursorValue(last), id: last.id })
        : null,
  };
}
