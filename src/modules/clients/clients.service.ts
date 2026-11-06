import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import {
  isForeignKeyViolation,
  isRecordNotFound,
  isUniqueViolation,
} from '../../common/prisma-errors.js';
import {
  decodeCursor,
  keysetFilter,
  keysetOrder,
  pageSize,
  toPage,
} from '../../common/pagination.js';
import { escapeLike } from '../../common/search.js';
import { AppConfigService } from '../../core/config/config.service.js';
import { TenantPrismaService } from '../../core/prisma/tenant-prisma.service.js';
import type { ListClientsQueryDto } from './dto/client.dto.js';

const SELECT = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} as const;

const NOT_FOUND = 'Client not found.';
const DUPLICATE_EMAIL = 'A client with this email already exists.';

/**
 * Clients of the current organisation. Uses ONLY the tenant-scoped client, so it cannot see
 * or change another organisation's clients even if a bug passed it a foreign id.
 */
@Injectable()
export class ClientsService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly config: AppConfigService,
  ) {}

  private get db() {
    return this.tenantDb.client;
  }

  async create(input: { name: string; email: string }) {
    try {
      // organizationId is stamped on by the tenant client.
      return await this.db.client.create({
        data: input as never,
        select: SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(DUPLICATE_EMAIL);
      throw error;
    }
  }

  async list(query: ListClientsQueryDto) {
    const limit = pageSize(query.limit, {
      defaultSize: this.config.get('PAGE_SIZE_DEFAULT'),
      maxSize: this.config.get('PAGE_SIZE_MAX'),
    });
    const after = keysetFilter('name', 'asc', decodeCursor(query.cursor));
    const search = query.q
      ? {
          OR: [
            {
              name: {
                contains: escapeLike(query.q),
                mode: 'insensitive' as const,
              },
            },
            {
              email: {
                contains: escapeLike(query.q),
                mode: 'insensitive' as const,
              },
            },
          ],
        }
      : undefined;

    const rows = await this.db.client.findMany({
      where: { AND: [search ?? {}, after ?? {}] },
      orderBy: keysetOrder('name', 'asc'),
      take: limit + 1,
      select: SELECT,
    });
    return toPage(rows, limit, (row) => row.name);
  }

  async get(id: string) {
    const client = await this.db.client.findFirst({
      where: { id },
      select: SELECT,
    });
    if (!client) throw new NotFoundError(NOT_FOUND);
    return client;
  }

  async update(id: string, input: { name?: string; email?: string }) {
    try {
      return await this.db.client.update({
        where: { id },
        data: input,
        select: SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundError(NOT_FOUND);
      if (isUniqueViolation(error)) throw new ConflictError(DUPLICATE_EMAIL);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await this.get(id); // 404 for unknown or foreign ids, before anything else
    // Financial records must not dangle: a client with invoices (even deleted ones) stays.
    const invoices = await this.db.invoice.count({ where: { clientId: id } });
    if (invoices > 0) {
      throw new ConflictError(
        'This client has invoices and cannot be deleted. Void its invoices instead.',
      );
    }
    try {
      await this.db.client.delete({ where: { id } });
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundError(NOT_FOUND);
      // An invoice was created between the check and the delete: the database refuses.
      if (isForeignKeyViolation(error)) {
        throw new ConflictError(
          'This client has invoices and cannot be deleted.',
        );
      }
      throw error;
    }
  }
}
