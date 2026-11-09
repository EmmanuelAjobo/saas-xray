import { h } from './dom.js';
import { formatClock } from './format.js';

/** What each kind of event looks like. */
const ICONS = {
  'tenant.check': '🏢',
  'auth.check': '🔐',
  'db.queries': '🗄️',
  'http.request': '↔',
  'email.sent': '✉️',
  'email.captured': '📬',
  'job.queued': '📋',
  'job.active': '⚙️',
  'job.completed': '✅',
  'job.retry': '🔁',
  'job.failed': '⛔',
};

const STATE_LABELS = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  unavailable: 'Unavailable',
  stopped: 'Stopped',
};

/** @param {import('./timeline.js').XrayEvent} event */
function stepRow(event, developer) {
  const meta = Object.entries(event.meta ?? {});
  return h(
    'li',
    { class: `step step-${event.severity}` },
    h(
      'span',
      { class: 'step-icon', 'aria-hidden': 'true' },
      ICONS[event.kind] ?? '•',
    ),
    h(
      'div',
      { class: 'step-body' },
      developer
        ? [
            h('div', { class: 'step-kind' }, event.kind),
            h(
              'dl',
              { class: 'meta' },
              meta.map(([key, value]) => [
                h('dt', null, key),
                h('dd', null, String(value)),
              ]),
            ),
            h('div', { class: 'step-id' }, `id ${event.id}`),
          ]
        : h('div', { class: 'step-summary' }, event.summary),
    ),
  );
}

/**
 * @param {import('./timeline.js').Group} group
 * @param {{ developer: boolean, open: boolean, onToggle: (key: string, open: boolean) => void }} options
 */
function card(group, { developer, open, onToggle }) {
  const request = group.request;
  const status = request?.meta?.status;
  const duration = request?.meta?.durationMs;
  return h(
    'details',
    {
      class: `card card-${group.severity}`,
      open,
      onToggle: (/** @type {Event} */ e) =>
        onToggle(
          group.key,
          /** @type {HTMLDetailsElement} */ (e.currentTarget).open,
        ),
    },
    h(
      'summary',
      null,
      h('span', { class: 'card-title' }, group.title),
      status !== undefined
        ? h('span', { class: `badge badge-${group.severity}` }, String(status))
        : null,
      duration !== undefined
        ? h('span', { class: 'card-duration' }, `${duration} ms`)
        : null,
      h('span', { class: 'card-time' }, formatClock(group.startedAt)),
    ),
    h(
      'ul',
      { class: 'steps' },
      group.events.map((event) => stepRow(event, developer)),
    ),
  );
}

/**
 * The X-ray panel: a live, plain-English timeline, one card per click.
 *
 * @param {{
 *   groups: import('./timeline.js').Group[],
 *   state: string,
 *   detail?: string,
 *   developer: boolean,
 *   isOpen: (key: string, index: number) => boolean,
 *   onToggleCard: (key: string, open: boolean) => void,
 *   onToggleView: (developer: boolean) => void,
 *   onClear: () => void,
 * }} props
 */
export function renderXrayPanel(props) {
  const { groups, state, detail, developer } = props;
  return h(
    'section',
    { class: 'panel xray', 'aria-label': 'Backend X-ray' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', null, 'Backend X-ray'),
      h(
        'span',
        { class: `status status-${state}` },
        STATE_LABELS[state] ?? state,
      ),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'View' },
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(!developer),
            onClick: () => props.onToggleView(false),
          },
          'Plain English',
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(developer),
            onClick: () => props.onToggleView(true),
          },
          'Developer',
        ),
      ),
      h(
        'button',
        { type: 'button', class: 'link', onClick: props.onClear },
        'Clear',
      ),
    ),
    state === 'unavailable'
      ? h('p', { class: 'empty' }, detail ?? 'The X-ray is not available.')
      : groups.length === 0
        ? h(
            'p',
            { class: 'empty' },
            'Nothing yet. Click something on the left and watch what the backend does for you.',
          )
        : h(
            'div',
            { class: 'cards', role: 'log', 'aria-live': 'off' },
            groups.map((group, index) =>
              card(group, {
                developer,
                open: props.isOpen(group.key, index),
                onToggle: props.onToggleCard,
              }),
            ),
          ),
    h(
      'p',
      { class: 'footnote' },
      'Every request you make is recorded here as it happens: membership, permission, database work and the answer. Nothing sensitive is ever shown: no tokens, bodies, emails or ids.',
    ),
  );
}
