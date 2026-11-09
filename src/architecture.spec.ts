import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REQUIRED_PERMISSION_KEY } from './modules/tenancy/require-permission.decorator.js';

/**
 * Rules about how the code is organised, enforced by tests so they cannot erode silently.
 */

const SRC = join(process.cwd(), 'src');

/** Time allowed for one controller's cold import (see the comment where it is used). */
const IMPORT_TIMEOUT_MS = 30_000;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const sources = (dir: string) =>
  walk(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

/** Modules that hold tenant data. They may use ONLY the tenant-scoped client. */
const DOMAIN_MODULES = ['clients', 'tasks', 'invoices'];

describe('architecture: domain code can only reach the database through the tenant-scoped client', () => {
  const files = DOMAIN_MODULES.flatMap((name) =>
    sources(join(SRC, 'modules', name)),
  );

  it('finds the domain modules (sanity check)', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))(
    '%s does not import the unscoped PrismaService or the base client',
    (_name, file) => {
      const text = readFileSync(file as string, 'utf8');
      // Matches ".../prisma/prisma.service.js" but not the allowed ".../tenant-prisma.service.js".
      expect(text).not.toMatch(/\/prisma\.service\.js['"]/);
      expect(text).not.toMatch(/\bnew PrismaClient\b/);
      expect(text).not.toMatch(/\$queryRaw|\$executeRaw/);
    },
  );

  it('every domain service takes TenantPrismaService', () => {
    const services = files.filter((f) => f.endsWith('.service.ts'));
    expect(services.length).toBe(DOMAIN_MODULES.length);
    for (const file of services) {
      expect(readFileSync(file, 'utf8')).toContain('TenantPrismaService');
    }
  });
});

describe('architecture: every route under /orgs/:orgId declares the permission it needs', () => {
  const controllers = sources(join(SRC, 'modules')).filter((f) =>
    f.endsWith('.controller.ts'),
  );

  it('finds the controllers (sanity check)', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(6);
  });

  it.each(controllers.map((f) => [relative(SRC, f), f]))(
    '%s',
    async (_name, file) => {
      const module = (await import(file as string)) as Record<string, unknown>;
      for (const exported of Object.values(module)) {
        if (typeof exported !== 'function') continue;
        const path = Reflect.getMetadata('path', exported) as
          string | undefined;
        if (typeof path !== 'string') continue; // not a controller

        const isTenantScoped = path.startsWith('orgs/:orgId');
        if (!isTenantScoped) continue;
        const classPermission = Reflect.getMetadata(
          REQUIRED_PERMISSION_KEY,
          exported,
        ) as string | undefined;

        const proto = (exported as { prototype: Record<string, unknown> })
          .prototype;
        for (const key of Object.getOwnPropertyNames(proto)) {
          const handler = proto[key];
          if (key === 'constructor' || typeof handler !== 'function') continue;
          if (Reflect.getMetadata('method', handler) === undefined) continue; // not a route
          const permission = Reflect.getMetadata(
            REQUIRED_PERMISSION_KEY,
            handler,
          ) as string | undefined;
          expect(
            permission ?? classPermission,
            `${(exported as { name: string }).name}.${key} has no @RequirePermission`,
          ).toBeDefined();
        }
      }
    },
    // The first import of a controller loads its whole dependency graph (the auth controller
    // pulls in the login stack). That is slow on a busy machine or a small CI runner, and
    // is not what this test is checking, so it gets room to import.
    IMPORT_TIMEOUT_MS,
  );
});
