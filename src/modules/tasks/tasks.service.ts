import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { RequestValidationException } from '../../common/errors/request-validation.exception.js';
import {
  decodeCursor,
  keysetFilter,
  keysetOrder,
  pageSize,
  toPage,
} from '../../common/pagination.js';
import { escapeLike } from '../../common/search.js';
import { AppConfigService } from '../../core/config/config.service.js';
import type { RequestTenant } from '../../core/context/request-context.service.js';
import { TenantPrismaService } from '../../core/prisma/tenant-prisma.service.js';
import type {
  CreateTaskDto,
  ListTasksQueryDto,
  UpdateTaskDto,
} from './dto/task.dto.js';

/** What a task looks like on the wire, including the assignee's name. */
const SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  createdById: true,
  dueDate: true,
  createdAt: true,
  updatedAt: true,
  assignee: { select: { id: true, user: { select: { name: true } } } },
} as const;

type TaskRow = Awaited<ReturnType<TasksService['findRow']>>;

function present(row: NonNullable<TaskRow>) {
  const { assignee, ...rest } = row as typeof row & {
    assignee: { id: string; user: { name: string } } | null;
  };
  return {
    ...rest,
    assignee: assignee ? { id: assignee.id, name: assignee.user.name } : null,
  };
}

const NOT_FOUND = 'Task not found.';
const isManager = (tenant: RequestTenant) => tenant.role !== 'MEMBER';

/**
 * Tasks of the current organisation (tenant-scoped client only).
 *
 * Roles: owners and admins manage every task. A MEMBER may edit tasks they created or are
 * assigned to, reassign only tasks they created, and delete only tasks they created
 * (ARCHITECTURE §8.3). The route guard says whether the ROLE may use the endpoint at all;
 * the rules here are about THIS task.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly config: AppConfigService,
  ) {}

  private get db() {
    return this.tenantDb.client;
  }

  /** Not-deleted task by id, within the current organisation. */
  findRow(id: string) {
    return this.db.task.findFirst({
      where: { id, deletedAt: null },
      select: SELECT,
    });
  }

  /** A field error for a membership id that is not in this organisation. */
  private async assertAssignable(assigneeId: string | null | undefined) {
    if (!assigneeId) return;
    const member = await this.db.membership.findFirst({
      where: { id: assigneeId },
      select: { id: true },
    });
    if (!member) {
      throw new RequestValidationException([
        {
          field: 'assigneeId',
          message: 'must be a member of this organization',
        },
      ]);
    }
  }

  async create(tenant: RequestTenant, dto: CreateTaskDto) {
    await this.assertAssignable(dto.assigneeId);
    const created = await this.db.task.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        status: dto.status,
        priority: dto.priority,
        assigneeId: dto.assigneeId ?? null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        createdById: tenant.membershipId,
      } as never,
      select: SELECT,
    });
    return present(created);
  }

  async list(tenant: RequestTenant, query: ListTasksQueryDto) {
    const limit = pageSize(query.limit, {
      defaultSize: this.config.get('PAGE_SIZE_DEFAULT'),
      maxSize: this.config.get('PAGE_SIZE_MAX'),
    });
    const after = keysetFilter(
      'createdAt',
      'desc',
      decodeCursor(query.cursor),
      (raw) => {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          throw new RequestValidationException([
            { field: 'cursor', message: 'is not a valid cursor' },
          ]);
        }
        return date;
      },
    );
    const assigneeId =
      query.assigneeId === 'me' ? tenant.membershipId : query.assigneeId;
    const search = query.q
      ? {
          OR: [
            {
              title: {
                contains: escapeLike(query.q),
                mode: 'insensitive' as const,
              },
            },
            {
              description: {
                contains: escapeLike(query.q),
                mode: 'insensitive' as const,
              },
            },
          ],
        }
      : {};

    const rows = await this.db.task.findMany({
      where: {
        deletedAt: null,
        status: query.status,
        priority: query.priority,
        assigneeId,
        AND: [search, after ?? {}],
      },
      orderBy: keysetOrder('createdAt', 'desc'),
      take: limit + 1,
      select: SELECT,
    });
    const page = toPage(rows, limit, (row) => row.createdAt.toISOString());
    return { ...page, data: page.data.map(present) };
  }

  async get(id: string) {
    const row = await this.findRow(id);
    if (!row) throw new NotFoundError(NOT_FOUND);
    return present(row);
  }

  async update(tenant: RequestTenant, id: string, dto: UpdateTaskDto) {
    const current = await this.db.task.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, assigneeId: true, createdById: true },
    });
    if (!current) throw new NotFoundError(NOT_FOUND);

    if (!isManager(tenant)) {
      const mine = current.createdById === tenant.membershipId;
      const assignedToMe = current.assigneeId === tenant.membershipId;
      if (!mine && !assignedToMe) {
        throw new ForbiddenError(
          'You can only edit tasks you created or are assigned to.',
        );
      }
      if (dto.assigneeId !== undefined && !mine) {
        throw new ForbiddenError(
          'Only the person who created a task can reassign it.',
        );
      }
    }
    if (dto.assigneeId !== undefined)
      await this.assertAssignable(dto.assigneeId);

    const updated = await this.db.task.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        assigneeId: dto.assigneeId,
        dueDate:
          dto.dueDate === undefined
            ? undefined
            : dto.dueDate === null
              ? null
              : new Date(dto.dueDate),
      },
      select: SELECT,
    });
    return present(updated);
  }

  /** Soft delete: the row stays (users expect "undo"), but disappears from every list. */
  async remove(tenant: RequestTenant, id: string): Promise<void> {
    const current = await this.db.task.findFirst({
      where: { id, deletedAt: null },
      select: { createdById: true },
    });
    if (!current) throw new NotFoundError(NOT_FOUND);
    if (!isManager(tenant) && current.createdById !== tenant.membershipId) {
      throw new ForbiddenError('You can only delete tasks you created.');
    }
    await this.db.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
