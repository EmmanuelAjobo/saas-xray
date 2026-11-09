/**
 * The background jobs the app knows. Each has a fixed name and a payload type, so a job can
 * only be queued with the data its handler expects.
 *
 * Payloads are stored in Redis, so they must hold nothing secret. That is why verification,
 * password-reset and invitation emails (whose links contain single-use tokens) are NOT jobs:
 * they stay in-process. An invoice email carries only what the client is meant to read.
 */
export interface JobBase {
  /** Joins the job's X-ray events to the request (click) that queued it. */
  requestId?: string;
}

export interface InvoiceEmailJob extends JobBase {
  organizationId: string;
  /** Used for the job id, so the same invoice's email can never be queued twice. */
  invoiceId: string;
  /** "send": really deliver it. "outbox": a demo sandbox, keep it in the Outbox instead. */
  delivery: 'send' | 'outbox';
  to: string;
  organizationName: string;
  clientName: string;
  number: string;
  amount: string;
  dueDate: string;
}

export type OverdueSweepJob = JobBase;

export interface JobData {
  'invoice-email': InvoiceEmailJob;
  'overdue-sweep': OverdueSweepJob;
}

export type JobName = keyof JobData;

/** How a job is named in plain English (for X-ray summaries). */
export const JOB_LABELS: Record<JobName, string> = {
  'invoice-email': 'invoice email',
  'overdue-sweep': 'overdue invoice sweep',
};

/** Facts about one run of a job. */
export interface JobContext {
  /** 1 for the first try. */
  attempt: number;
  /** Tries in total before the job is given up on. */
  attempts: number;
}

export type JobHandler<N extends JobName = JobName> = (
  data: JobData[N],
  context: JobContext,
) => Promise<void>;

/** Where jobs wait to be run. Redis (BullMQ) in production; in-process in tests. */
export interface JobQueue {
  add<N extends JobName>(
    name: N,
    data: JobData[N],
    options?: { jobId?: string },
  ): Promise<void>;
}

export const JOB_QUEUE = Symbol('JOB_QUEUE');
