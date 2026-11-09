import { MAX_MODELS_LISTED, MAX_TEXT_LENGTH } from './xray.limits.js';

/**
 * What the Backend X-ray says about a request.
 *
 * Privacy by construction: events are made ONLY by the builders below, from typed fields.
 * There is no way to pass a request body, header, token, email address or id into one, so a
 * future change cannot leak them by accident. Routes are shown as templates
 * ("/invoices/:id/send"), never with the real ids.
 */

export type XrayKind =
  | 'http.request'
  | 'tenant.check'
  | 'auth.check'
  | 'db.queries'
  | 'email.sent'
  | 'email.captured';

export type XraySeverity = 'info' | 'success' | 'warn' | 'error';

/** Technical details for a "developer view": only plain values, never nested data. */
export type XrayMeta = Record<string, string | number | boolean | null>;

/** An event before the store has given it its id and position. */
export interface NewXrayEvent {
  /** Epoch milliseconds. */
  ts: number;
  /** Groups the events of one click. Absent for work that is not part of a request. */
  requestId?: string;
  kind: XrayKind;
  severity: XraySeverity;
  /** Short heading. */
  title: string;
  /** One plain-English sentence for non-technical viewers. */
  summary: string;
  meta: XrayMeta;
}

/** A stored event. `id` is its position in the organisation's stream and orders events. */
export interface XrayEvent extends NewXrayEvent {
  id: string;
}

/** Control characters out, length bounded: text from our own code, but keep it boring. */
export function plain(text: string, max = MAX_TEXT_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STATUS_MEANING: Record<number, string> = {
  400: 'rejected because the input was invalid',
  401: 'refused because the caller is not signed in',
  403: 'refused because this role is not allowed',
  404: 'not found',
  409: 'refused because it conflicts with the current state',
  422: 'rejected because the input was invalid',
  429: 'refused because of the rate limit',
};

function meaning(status: number): string {
  const known = STATUS_MEANING[status];
  if (known) return known;
  if (status >= 500) return 'failed on the server';
  if (status >= 400) return 'rejected';
  return 'succeeded';
}

/** "/v1/orgs/:orgId/invoices/:id/send" → "/invoices/:id/send" for the heading. */
function shortRoute(route: string): string {
  return route.replace(/^\/v\d+\/orgs\/:orgId/, '') || '/';
}

export function httpRequestEvent(input: {
  ts: number;
  requestId?: string;
  method: string;
  /** The route TEMPLATE (with :placeholders), never the real URL. */
  route: string;
  status: number;
  durationMs: number;
}): NewXrayEvent {
  const ms = Math.max(0, Math.round(input.durationMs));
  return {
    ts: input.ts,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    kind: 'http.request',
    severity:
      input.status >= 500 ? 'error' : input.status >= 400 ? 'warn' : 'success',
    title: plain(`${input.method} ${shortRoute(input.route)}`),
    summary: plain(
      `Answered ${input.status} in ${ms} ms: ${meaning(input.status)}.`,
    ),
    meta: {
      method: input.method,
      route: plain(input.route),
      status: input.status,
      durationMs: ms,
    },
  };
}

export function tenantCheckEvent(input: {
  ts: number;
  role: string;
}): NewXrayEvent {
  return {
    ts: input.ts,
    kind: 'tenant.check',
    severity: 'success',
    title: 'Organisation membership',
    summary: plain(
      `Confirmed you belong to this organisation as ${input.role}. Your role is read fresh from the database on every request.`,
    ),
    meta: { role: input.role },
  };
}

export function authCheckEvent(input: {
  ts: number;
  role: string;
  permission: string;
  allowed: boolean;
}): NewXrayEvent {
  return {
    ts: input.ts,
    kind: 'auth.check',
    severity: input.allowed ? 'success' : 'warn',
    title: 'Permission check',
    summary: plain(
      input.allowed
        ? `Role ${input.role} holds "${input.permission}", so the request was allowed.`
        : `Role ${input.role} does not hold "${input.permission}". Refused before any data was read or changed.`,
    ),
    meta: {
      role: input.role,
      permission: input.permission,
      allowed: input.allowed,
    },
  };
}

export function dbQueriesEvent(input: {
  ts: number;
  count: number;
  totalMs: number;
  models: Iterable<string>;
}): NewXrayEvent {
  const ms = Math.round(input.totalMs);
  const models = [...new Set(input.models)].sort().slice(0, MAX_MODELS_LISTED);
  return {
    ts: input.ts,
    kind: 'db.queries',
    severity: 'info',
    title: 'Database',
    summary: plain(
      `${input.count} database ${input.count === 1 ? 'query' : 'queries'} in ${ms} ms, each one confined to this organisation.`,
    ),
    meta: {
      queries: input.count,
      totalMs: ms,
      models: models.join(', '),
    },
  };
}

export function emailEvent(input: {
  ts: number;
  /** A fixed template name from our own code, e.g. "invoice-sent". */
  template: string;
  /** "sent": really delivered. "captured": a demo sandbox kept it in its Outbox instead. */
  outcome: 'sent' | 'captured';
}): NewXrayEvent {
  const sent = input.outcome === 'sent';
  return {
    ts: input.ts,
    kind: sent ? 'email.sent' : 'email.captured',
    severity: sent ? 'success' : 'info',
    title: sent ? 'Email sent' : 'Email captured',
    summary: sent
      ? 'The email was handed to the mail provider after the response had already gone out.'
      : 'Not sent: demo sandboxes never send real email. It is kept in your Outbox so you can see it.',
    meta: { template: plain(input.template, 60) },
  };
}
