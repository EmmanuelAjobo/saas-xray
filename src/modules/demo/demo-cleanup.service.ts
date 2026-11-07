import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HOUR_MS, MINUTE_MS } from '../../common/time.js';
import { AppConfigService } from '../../core/config/config.service.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import { removeDemoOrganization } from '../../seed/demo-template.js';

/** Slug prefix the seed gives every sandbox: `acme-studio-<tag>`. */
const SLUG_PREFIX = 'acme-studio-';
/** The permanent sample organisation made by `npm run db:seed`; never purged. */
const TEMPLATE_SLUG = `${SLUG_PREFIX}template`;

export interface PurgeResult {
  organizations: number;
  users: number;
}

/**
 * Deletes demo sandboxes once they expire (ARCHITECTURE §18). Everything an organisation owns
 * goes with it (the database cascades), as do its demo users.
 *
 * It runs on a timer inside the API process for now. When the job queue arrives
 * (Milestone 10) this becomes the hourly `cleanup-demo-orgs` job without changing
 * `purgeExpired()`. Several API instances may run it at once: every step is a plain delete,
 * so overlapping runs are harmless.
 */
@Injectable()
export class DemoCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<PurgeResult>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const minutes = this.config.get('DEMO_PURGE_INTERVAL_MINUTES');
    if (minutes === 0) return;
    this.timer = setInterval(() => void this.runOnce(), minutes * MINUTE_MS);
    this.timer.unref(); // never keeps the process alive on its own
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** One run, never overlapping itself, never throwing into the timer. */
  runOnce(): Promise<PurgeResult> {
    this.running ??= this.purgeExpired()
      .catch((error: unknown) => {
        this.logger.error(
          `Demo cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { organizations: 0, users: 0 };
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async purgeExpired(now = new Date()): Promise<PurgeResult> {
    const expired = await this.prisma.organization.findMany({
      where: {
        isDemo: true,
        demoExpiresAt: { lte: now },
        slug: { not: TEMPLATE_SLUG },
      },
      orderBy: { demoExpiresAt: 'asc' },
      take: this.config.get('DEMO_PURGE_BATCH_SIZE'),
      select: { slug: true },
    });

    let organizations = 0;
    for (const { slug } of expired) {
      try {
        if (
          await removeDemoOrganization(
            this.prisma,
            slug.slice(SLUG_PREFIX.length),
          )
        ) {
          organizations++;
        }
      } catch (error) {
        // One unremovable row must not block the rest.
        this.logger.error(
          `Could not remove demo organisation ${slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // A visitor who deleted their own sandbox leaves its demo users behind with no
    // organisation; sweep those up once they are older than a sandbox's lifetime.
    const cutoff = new Date(
      now.getTime() - this.config.get('DEMO_TTL_HOURS') * HOUR_MS,
    );
    const orphans = await this.prisma.user.deleteMany({
      where: {
        isDemo: true,
        memberships: { none: {} },
        createdAt: { lte: cutoff },
      },
    });

    if (organizations > 0 || orphans.count > 0) {
      this.logger.log(
        `Demo cleanup removed ${organizations} sandbox(es) and ${orphans.count} orphaned user(s)`,
      );
    }
    return { organizations, users: orphans.count };
  }
}
