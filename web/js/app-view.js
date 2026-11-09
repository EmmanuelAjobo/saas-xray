import { h } from './dom.js';
import { daysUntil, formatClock, formatMoney, sentenceCase } from './format.js';

const ROLES = [
  { role: 'OWNER', label: 'Owner', hint: 'Full control' },
  { role: 'ADMIN', label: 'Admin', hint: 'Manages invoices and people' },
  { role: 'MEMBER', label: 'Member', hint: 'Read-mostly' },
];

/** The first screen: one clear thing to do. */
export function renderLanding({ busy, error, realAccount, onStart }) {
  return h(
    'main',
    { class: 'landing' },
    h('p', { class: 'eyebrow' }, 'SaaS X-ray'),
    h('h1', null, 'Watch a backend think.'),
    h(
      'p',
      { class: 'lead' },
      'Click around a real multi-tenant invoicing app. Next to it, the X-ray narrates every permission check, database query and email as it happens.',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'primary big',
        disabled: busy,
        onClick: onStart,
      },
      busy ? 'Setting up your sandbox…' : 'Start the live demo',
    ),
    error ? h('p', { class: 'form-error', role: 'alert' }, error) : null,
    realAccount
      ? h(
          'p',
          { class: 'notice' },
          'You are signed in to a real account in this browser. The demo is a separate sandbox, so starting it signs you out of that account here.',
        )
      : null,
    h(
      'ul',
      { class: 'promises' },
      h('li', null, 'No sign-up. You get your own private sandbox.'),
      h(
        'li',
        null,
        'Nothing you do touches anyone else’s data, and it expires on its own.',
      ),
      h('li', null, 'Try to break it: the server says no, and tells you why.'),
    ),
    h('p', { class: 'small' }, h('a', { href: '/docs' }, 'API documentation')),
  );
}

/**
 * The page once signed in: header, the app on the left, the X-ray on the right.
 * Returns the root and the places the live parts are drawn into.
 */
export function renderShell({
  org,
  role,
  busy,
  onRole,
  onNewSandbox,
  onSignOut,
}) {
  const invoicesSlot = h('div', { class: 'slot' });
  const outboxSlot = h('div', { class: 'slot' });
  const tryItSlot = h('div', { class: 'slot' });
  const xraySlot = h('div', { class: 'slot xray-slot' });
  const root = h(
    'div',
    { class: 'shell' },
    h(
      'header',
      { class: 'topbar' },
      h('span', { class: 'brand' }, 'SaaS X-ray'),
      h('span', { class: 'org' }, org.name),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Who you are' },
        ROLES.map((r) =>
          h(
            'button',
            {
              type: 'button',
              title: r.hint,
              'aria-pressed': String(role === r.role),
              disabled: busy,
              onClick: () => onRole(r.role),
            },
            r.label,
          ),
        ),
      ),
      h('span', { class: 'spacer' }),
      h('a', { class: 'link', href: '/docs' }, 'API docs'),
      h(
        'button',
        { type: 'button', class: 'link', onClick: onNewSandbox },
        'New sandbox',
      ),
      h(
        'button',
        { type: 'button', class: 'link', onClick: onSignOut },
        'Leave',
      ),
    ),
    h(
      'div',
      { class: 'columns' },
      h(
        'div',
        { class: 'left' },
        h(
          'p',
          { class: 'intro' },
          'You are the ',
          h('strong', null, sentenceCase(role)),
          ' of a demo company. Switch roles above, click around, then watch the X-ray.',
        ),
        invoicesSlot,
        outboxSlot,
        tryItSlot,
      ),
      h('div', { class: 'right' }, xraySlot),
    ),
  );
  return { root, invoicesSlot, outboxSlot, tryItSlot, xraySlot };
}

const STATUS_HINTS = {
  DRAFT: 'Not sent yet',
  SENT: 'Waiting for payment',
  PAID: 'Paid',
  OVERDUE: 'Past due',
  VOID: 'Cancelled',
};

function dueText(invoice, now) {
  if (invoice.status === 'PAID' || invoice.status === 'VOID') return '';
  const days = daysUntil(invoice.dueDate, now);
  if (days === null) return 'No due date';
  if (days < 0) return `${-days} d overdue`;
  if (days === 0) return 'Due today';
  return `Due in ${days} d`;
}

/** The invoices table, with the three actions on every row (a refusal is part of the demo). */
export function renderInvoices({
  invoices,
  loading,
  busy,
  now,
  onNew,
  onSend,
  onPay,
  onVoid,
}) {
  return h(
    'section',
    { class: 'panel' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', null, 'Invoices'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        { type: 'button', class: 'primary', disabled: busy, onClick: onNew },
        'New invoice',
      ),
    ),
    invoices.length === 0
      ? h(
          'p',
          { class: 'empty' },
          loading ? 'Loading…' : 'No invoices yet. Create one.',
        )
      : h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['Number', 'Client', 'Status', 'Total', 'Due', ''].map(
                  (label) => h('th', { scope: 'col' }, label),
                ),
              ),
            ),
            h(
              'tbody',
              null,
              invoices.map((invoice) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'num' }, invoice.number),
                  h('td', null, invoice.client?.name ?? ''),
                  h(
                    'td',
                    null,
                    h(
                      'span',
                      {
                        class: `status-pill pill-${invoice.status.toLowerCase()}`,
                        title: STATUS_HINTS[invoice.status],
                      },
                      sentenceCase(invoice.status),
                    ),
                  ),
                  h(
                    'td',
                    { class: 'money' },
                    formatMoney(invoice.totalCents, invoice.currency),
                  ),
                  h('td', { class: 'due' }, dueText(invoice, now)),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { class: 'row-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          disabled: busy,
                          onClick: () => onSend(invoice),
                        },
                        'Send',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          disabled: busy,
                          onClick: () => onPay(invoice),
                        },
                        'Mark paid',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          disabled: busy,
                          onClick: () => onVoid(invoice),
                        },
                        'Void',
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}

/** Buttons that deliberately ask for things that should be refused. */
export function renderTryIt({
  busy,
  role,
  onPayDraft,
  onCreateClient,
  onPeek,
}) {
  const item = (title, text, label, onClick) =>
    h(
      'li',
      null,
      h('div', null, h('strong', null, title), h('p', null, text)),
      h('button', { type: 'button', disabled: busy, onClick }, label),
    );
  return h(
    'section',
    { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h2', null, 'Try to break it')),
    h(
      'ul',
      { class: 'try-list' },
      item(
        'Pay an invoice that was never sent',
        'The rules live on the server, not the screen.',
        'Try it',
        onPayDraft,
      ),
      item(
        'Create a client',
        role === 'MEMBER'
          ? 'You are a Member, so the server should refuse.'
          : 'Works for Owner and Admin. Switch to Member and try again.',
        'Try it',
        onCreateClient,
      ),
      item(
        'Peek at another company',
        'A stranger from a different company asks for your data.',
        'Try it',
        onPeek,
      ),
    ),
  );
}

/** A short message that fades by itself. Tone: ok | refused | error. */
export function renderToast({ tone, text, onClose }) {
  const label = { ok: 'Done', refused: 'Backend said no', error: 'Problem' }[
    tone
  ];
  return h(
    'div',
    { class: `toast toast-${tone}` },
    h('strong', null, label),
    h('p', null, text),
    h(
      'button',
      {
        type: 'button',
        class: 'link',
        'aria-label': 'Dismiss',
        onClick: onClose,
      },
      '✕',
    ),
  );
}

/**
 * The emails this demo sandbox "sent". Demo sandboxes never deliver real email, so the
 * message is kept here instead, and the visitor sees what the client would have received.
 * The body is shown with `<pre>` and text nodes only: it contains names a visitor typed, so
 * it must never be treated as HTML.
 */
export function renderOutbox({ messages }) {
  return h(
    'section',
    { class: 'panel' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', null, 'Outbox'),
      h('span', { class: 'hint' }, 'Demo sandboxes never send real email'),
    ),
    messages.length === 0
      ? h(
          'p',
          { class: 'empty' },
          'Send an invoice and the email your client would receive appears here.',
        )
      : h(
          'ul',
          { class: 'mails' },
          messages.map((message, index) =>
            h(
              'li',
              null,
              h(
                'details',
                { class: 'mail', open: index === 0 },
                h(
                  'summary',
                  null,
                  h('span', { class: 'mail-subject' }, message.subject),
                  h('span', { class: 'mail-to' }, `To ${message.to}`),
                  h('span', { class: 'card-time' }, formatClock(message.ts)),
                ),
                h('pre', { class: 'mail-body' }, message.text),
              ),
            ),
          ),
        ),
  );
}
