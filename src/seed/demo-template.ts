import { DAY_MS, HOUR_MS } from '../common/time.js';
import { invoiceNumber } from '../modules/invoices/invoice-number.js';
import { envSchema } from '../core/config/env.schema.js';
import {
  InvoiceStatus,
  Plan,
  Role,
  SubscriptionStatus,
  TaskPriority,
  TaskStatus,
  type PrismaClient,
} from '../generated/prisma/client.js';

/** One source of truth: the default lives in the env schema (DEMO_TTL_HOURS). */
const DEFAULT_DEMO_TTL_HOURS = envSchema.shape.DEMO_TTL_HOURS.parse(undefined);

/**
 * The demo organisation: a believable small agency, so a visitor sees a full, realistic
 * workspace instead of an empty app (ARCHITECTURE.md §18).
 *
 * One function builds it. `npm run db:seed` uses it for local development, and Milestone 8's
 * `POST /auth/demo` calls the same function to give every visitor their own sandbox.
 * All data is fictional: `.example` is a reserved TLD that can never receive real mail.
 */

const TAG_PATTERN = /^[a-z0-9-]{1,32}$/;

// ───────────────────────────── The data ─────────────────────────────

/** Role order matters: index 0 is the owner, and tasks reference people by index. */
export const DEMO_PEOPLE = [
  { first: 'alex', last: 'morgan', name: 'Alex Morgan', role: Role.OWNER },
  { first: 'priya', last: 'nair', name: 'Priya Nair', role: Role.ADMIN },
  { first: 'tomas', last: 'silva', name: 'Tomás Silva', role: Role.MEMBER },
] as const;

export const DEMO_CLIENTS = [
  { name: 'Northwind Studio', email: 'billing@northwind.example' },
  { name: 'Brightside Bakery', email: 'hello@brightside-bakery.example' },
  { name: 'Kestrel Logistics', email: 'accounts@kestrel.example' },
  { name: 'Lumen Health', email: 'finance@lumen-health.example' },
  { name: 'Orchard & Co', email: 'office@orchard-co.example' },
  { name: 'Vantage Robotics', email: 'ap@vantage-robotics.example' },
] as const;

interface DemoTask {
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Index into DEMO_PEOPLE, or null for unassigned. */
  assignee: number | null;
  /** Days from now (negative = overdue), or null for no due date. */
  dueInDays: number | null;
  description?: string;
}

const { TODO, IN_PROGRESS, DONE } = TaskStatus;
const { LOW, MEDIUM, HIGH } = TaskPriority;

export const DEMO_TASKS: DemoTask[] = [
  {
    title: 'Kickoff call with Lumen Health',
    status: DONE,
    priority: MEDIUM,
    assignee: 0,
    dueInDays: -20,
    description: 'Agree scope, timeline and the single point of contact.',
  },
  {
    title: 'Collect brand assets from Northwind',
    status: DONE,
    priority: LOW,
    assignee: 2,
    dueInDays: -18,
  },
  {
    title: 'Draft homepage wireframes',
    status: DONE,
    priority: HIGH,
    assignee: 1,
    dueInDays: -14,
  },
  {
    title: 'Set up shared design library',
    status: DONE,
    priority: MEDIUM,
    assignee: 1,
    dueInDays: -12,
  },
  {
    title: 'Review contract terms for Kestrel',
    status: DONE,
    priority: HIGH,
    assignee: 0,
    dueInDays: -10,
  },
  {
    title: 'Order printed samples for Orchard & Co',
    status: DONE,
    priority: LOW,
    assignee: 2,
    dueInDays: -7,
  },
  {
    title: 'Publish case study: Brightside rebrand',
    status: DONE,
    priority: MEDIUM,
    assignee: 0,
    dueInDays: -5,
  },
  {
    title: 'Build Lumen landing page',
    status: IN_PROGRESS,
    priority: HIGH,
    assignee: 1,
    dueInDays: 3,
    description: 'Hero, pricing table, signup form. Copy is approved.',
  },
  {
    title: 'Edit Vantage product demo video',
    status: IN_PROGRESS,
    priority: HIGH,
    assignee: 2,
    dueInDays: 2,
  },
  {
    title: 'Design packaging for Orchard & Co',
    status: IN_PROGRESS,
    priority: MEDIUM,
    assignee: 1,
    dueInDays: 6,
  },
  {
    title: 'Write onboarding emails for Kestrel',
    status: IN_PROGRESS,
    priority: MEDIUM,
    assignee: 0,
    dueInDays: 4,
  },
  {
    title: 'Fix mobile nav on Northwind site',
    status: IN_PROGRESS,
    priority: LOW,
    assignee: 2,
    dueInDays: 1,
  },
  {
    title: 'Prepare Q4 invoicing run',
    status: IN_PROGRESS,
    priority: HIGH,
    assignee: 0,
    dueInDays: 5,
  },
  {
    title: 'Photography direction for menu shoot',
    status: IN_PROGRESS,
    priority: MEDIUM,
    assignee: 1,
    dueInDays: 8,
  },
  {
    title: 'Plan seasonal campaign for Northwind',
    status: TODO,
    priority: MEDIUM,
    assignee: 0,
    dueInDays: 14,
  },
  {
    title: 'Chase overdue invoice from Kestrel',
    status: TODO,
    priority: HIGH,
    assignee: 0,
    dueInDays: -1,
  },
  {
    title: 'Update portfolio with new work',
    status: TODO,
    priority: LOW,
    assignee: null,
    dueInDays: null,
  },
  {
    title: 'Research accessibility audit tools',
    status: TODO,
    priority: LOW,
    assignee: 2,
    dueInDays: 21,
  },
  {
    title: 'Quote for Vantage trade-show booth',
    status: TODO,
    priority: MEDIUM,
    assignee: 1,
    dueInDays: 10,
  },
  {
    title: 'Renew design software licences',
    status: TODO,
    priority: MEDIUM,
    assignee: 0,
    dueInDays: 12,
  },
  {
    title: 'Interview freelance illustrator',
    status: TODO,
    priority: LOW,
    assignee: null,
    dueInDays: 18,
  },
  {
    title: 'Write proposal for Lumen phase 2',
    status: TODO,
    priority: HIGH,
    assignee: 1,
    dueInDays: 9,
  },
  {
    title: 'Archive finished project files',
    status: TODO,
    priority: LOW,
    assignee: 2,
    dueInDays: null,
  },
  {
    title: 'Team retro: what slowed us down?',
    status: TODO,
    priority: LOW,
    assignee: null,
    dueInDays: 16,
  },
  {
    title: 'Set up client feedback form',
    status: TODO,
    priority: MEDIUM,
    assignee: 2,
    dueInDays: 11,
  },
];

/** [description, quantity, unit price in cents] */
type LineItem = readonly [string, number, number];

interface DemoInvoice {
  /** Index into DEMO_CLIENTS. */
  client: number;
  status: InvoiceStatus;
  /** How many days ago it was created. */
  ageInDays: number;
  /** Days from now (negative = already past). */
  dueInDays: number;
  items: readonly LineItem[];
}

const { DRAFT, SENT, PAID, OVERDUE, VOID } = InvoiceStatus;

/** Numbered INV-0001.. in this order. Every status appears, so every UI state is demoable. */
export const DEMO_INVOICES: DemoInvoice[] = [
  {
    client: 0,
    status: PAID,
    ageInDays: 75,
    dueInDays: -45,
    items: [
      ['Brand identity refresh', 1, 420_000],
      ['Logo usage guidelines', 1, 80_000],
    ],
  },
  {
    client: 1,
    status: PAID,
    ageInDays: 60,
    dueInDays: -30,
    items: [['Website copywriting (pages)', 6, 45_000]],
  },
  {
    client: 2,
    status: PAID,
    ageInDays: 50,
    dueInDays: -20,
    items: [
      ['Dashboard UI design', 1, 950_000],
      ['Design review workshop (hours)', 4, 15_000],
    ],
  },
  {
    client: 3,
    status: SENT,
    ageInDays: 18,
    dueInDays: 12,
    items: [['Landing page build', 1, 720_000]],
  },
  {
    client: 4,
    status: SENT,
    ageInDays: 10,
    dueInDays: 20,
    items: [
      ['Packaging mockups', 3, 60_000],
      ['Print-ready files', 1, 35_000],
    ],
  },
  {
    client: 5,
    status: SENT,
    ageInDays: 5,
    dueInDays: 25,
    items: [['Product demo video edit (hours)', 16, 9_500]],
  },
  {
    client: 2,
    status: OVERDUE,
    ageInDays: 45,
    dueInDays: -10,
    items: [['Quarterly retainer: support', 1, 300_000]],
  },
  {
    client: 0,
    status: DRAFT,
    ageInDays: 2,
    dueInDays: 30,
    items: [['Seasonal campaign assets', 1, 540_000]],
  },
  {
    client: 1,
    status: DRAFT,
    ageInDays: 1,
    dueInDays: 30,
    items: [
      ['Menu redesign', 1, 180_000],
      ['Photography direction (hours)', 5, 12_000],
    ],
  },
  {
    client: 3,
    status: VOID,
    ageInDays: 40,
    dueInDays: -5,
    items: [['Duplicate invoice (voided)', 1, 720_000]],
  },
];

export { invoiceNumber };

export function invoiceTotalCents(items: readonly LineItem[]): number {
  return items.reduce(
    (sum, [, quantity, unitCents]) => sum + quantity * unitCents,
    0,
  );
}

// ───────────────────────────── The builder ─────────────────────────────

export interface DemoOptions {
  /**
   * Makes the slug and user emails unique so many demo orgs can coexist
   * (`acme-studio-<tag>`, `alex.morgan.<tag>@demo.local`). Lower-case letters, digits, hyphens.
   */
  tag?: string;
  /** Anchor for every relative date. Defaults to now; tests pass a fixed value. */
  now?: Date;
  /** Hours until the sandbox is eligible for cleanup. */
  ttlHours?: number;
}

export interface DemoSeedResult {
  organizationId: string;
  slug: string;
  ownerUserId: string;
  ownerMembershipId: string;
  counts: {
    users: number;
    tasks: number;
    clients: number;
    invoices: number;
    lineItems: number;
  };
}

function resolveTag(tag: string | undefined): string {
  const value = tag ?? 'template';
  if (!TAG_PATTERN.test(value)) {
    throw new Error(
      `Invalid demo tag "${value}": use 1-32 lower-case letters, digits or hyphens.`,
    );
  }
  return value;
}

const plusDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * DAY_MS);

const demoEmail = (person: (typeof DEMO_PEOPLE)[number], tag: string): string =>
  `${person.first}.${person.last}.${tag}@demo.local`;

/**
 * Creates one complete demo organisation in a single transaction: either everything exists
 * or nothing does. Throws if an organisation with this tag already exists (use
 * {@link removeDemoOrganization} first).
 */
export async function seedDemoOrganization(
  prisma: PrismaClient,
  options: DemoOptions = {},
): Promise<DemoSeedResult> {
  const tag = resolveTag(options.tag);
  const now = options.now ?? new Date();
  const ttlHours = options.ttlHours ?? DEFAULT_DEMO_TTL_HOURS;
  const slug = `acme-studio-${tag}`;

  return prisma.$transaction(
    async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: 'Acme Studio (demo)',
          slug,
          isDemo: true,
          demoExpiresAt: new Date(now.getTime() + ttlHours * HOUR_MS),
          // Invoices are numbered from this counter; it ends equal to the last number issued.
          invoiceSeq: DEMO_INVOICES.length,
          createdAt: now,
          subscription: {
            create: { plan: Plan.FREE, status: SubscriptionStatus.ACTIVE },
          },
        },
      });

      // People: demo users never have a password; demo sessions are issued by the demo endpoint.
      const memberships: string[] = [];
      let ownerUserId = '';
      for (const person of DEMO_PEOPLE) {
        const user = await tx.user.create({
          data: {
            email: demoEmail(person, tag),
            name: person.name,
            isDemo: true,
            emailVerifiedAt: now,
            createdAt: now,
          },
        });
        const membership = await tx.membership.create({
          data: {
            userId: user.id,
            organizationId: organization.id,
            role: person.role,
          },
        });
        memberships.push(membership.id);
        if (person.role === Role.OWNER) ownerUserId = user.id;
      }

      await tx.client.createMany({
        data: DEMO_CLIENTS.map((client) => ({
          ...client,
          organizationId: organization.id,
        })),
      });
      const clients = await tx.client.findMany({
        where: { organizationId: organization.id },
        select: { id: true, email: true },
      });
      const clientIdByEmail = new Map(clients.map((c) => [c.email, c.id]));

      // Spread creation times so lists sort naturally: oldest tasks first.
      await tx.task.createMany({
        data: DEMO_TASKS.map((task, index) => ({
          organizationId: organization.id,
          title: task.title,
          description: task.description ?? null,
          status: task.status,
          priority: task.priority,
          assigneeId:
            task.assignee === null
              ? null
              : (memberships[task.assignee] ?? null),
          dueDate:
            task.dueInDays === null ? null : plusDays(now, task.dueInDays),
          createdAt: plusDays(now, index - DEMO_TASKS.length),
        })),
      });

      let lineItemCount = 0;
      for (const [index, invoice] of DEMO_INVOICES.entries()) {
        const clientEmail = DEMO_CLIENTS[invoice.client]?.email;
        const clientId = clientEmail
          ? clientIdByEmail.get(clientEmail)
          : undefined;
        if (!clientId)
          throw new Error(
            `Demo invoice ${index + 1} references a missing client.`,
          );
        await tx.invoice.create({
          data: {
            organizationId: organization.id,
            clientId,
            number: invoiceNumber(index + 1),
            status: invoice.status,
            totalCents: invoiceTotalCents(invoice.items),
            currency: 'USD',
            dueDate: plusDays(now, invoice.dueInDays),
            createdAt: plusDays(now, -invoice.ageInDays),
            lineItems: {
              create: invoice.items.map(
                ([description, quantity, unitPriceCents]) => ({
                  description,
                  quantity,
                  unitPriceCents,
                }),
              ),
            },
          },
        });
        lineItemCount += invoice.items.length;
      }

      return {
        organizationId: organization.id,
        slug,
        ownerUserId,
        ownerMembershipId: memberships[0] ?? '',
        counts: {
          users: DEMO_PEOPLE.length,
          tasks: DEMO_TASKS.length,
          clients: DEMO_CLIENTS.length,
          invoices: DEMO_INVOICES.length,
          lineItems: lineItemCount,
        },
      };
    },
    { timeout: 20_000 },
  );
}

/**
 * Deletes a demo organisation and its users. Deleting the organisation cascades to every
 * tenant-owned row (tasks, clients, invoices, files, audit log...), but users are global,
 * so they are removed explicitly. Only users flagged `isDemo` are ever touched.
 * Returns whether anything existed.
 */
export async function removeDemoOrganization(
  prisma: PrismaClient,
  tag = 'template',
): Promise<boolean> {
  const resolved = resolveTag(tag);
  return prisma.$transaction(async (tx) => {
    const orgs = await tx.organization.deleteMany({
      where: { slug: `acme-studio-${resolved}`, isDemo: true },
    });
    const users = await tx.user.deleteMany({
      where: { isDemo: true, email: { endsWith: `.${resolved}@demo.local` } },
    });
    return orgs.count > 0 || users.count > 0;
  });
}
