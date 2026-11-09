import {
  createClient,
  createInvoice,
  payADraft,
  payInvoice,
  peekAsStranger,
  returningVisitor,
  sendInvoice,
  voidInvoice,
} from './actions.js';
import { ApiError, createApi } from './api.js';
import {
  renderInvoices,
  renderLanding,
  renderOutbox,
  renderShell,
  renderToast,
  renderTryIt,
} from './app-view.js';
import { mount } from './dom.js';
import { createTimeline } from './timeline.js';
import { renderXrayPanel } from './xray-panel.js';
import { startXrayStream } from './xray-stream.js';

/** How long a message stays on screen. */
const TOAST_MS = 9_000;
/** Invoices and clients fetched for the screen (the demo company has about ten). */
const LIST_LIMIT = 50;

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const toasts = /** @type {HTMLElement} */ (document.getElementById('toasts'));
const api = createApi();

const state = {
  phase: 'boot', // boot | landing | app
  starting: false,
  startError: '',
  realAccount: false,
  busy: false,
  org: /** @type {{ id: string, name: string } | undefined} */ (undefined),
  role: 'OWNER',
  invoices: /** @type {any[]} */ ([]),
  clients: /** @type {any[]} */ ([]),
  /** Emails the demo sandbox "sent" (captured, never delivered). */
  outbox: /** @type {any[]} */ ([]),
  loadingInvoices: false,
  developer: false,
  stream: {
    state: 'connecting',
    detail: /** @type {string | undefined} */ (undefined),
  },
  sample: 0,
};

const timeline = createTimeline();
/** Whether each X-ray card is open, remembered across redraws. */
const openCards = new Map();
let stream;
let shell;

// ───────────────────────────── messages ─────────────────────────────

function toast(outcome) {
  const element = renderToast({
    ...outcome,
    onClose: () => element.remove(),
  });
  toasts.replaceChildren(element); // one message at a time keeps the screen calm
  setTimeout(() => element.remove(), TOAST_MS);
}

// ───────────────────────────── drawing ─────────────────────────────

function drawInvoices() {
  if (!shell) return;
  mount(
    shell.invoicesSlot,
    renderInvoices({
      invoices: state.invoices,
      loading: state.loadingInvoices,
      busy: state.busy,
      now: Date.now(),
      onNew: () =>
        run(() =>
          createInvoice(
            api,
            state.org.id,
            state.clients[0]?.id,
            state.sample++,
          ),
        ),
      onSend: (invoice) =>
        run(() => sendInvoice(api, state.org.id, invoice), { outbox: true }),
      onPay: (invoice) => run(() => payInvoice(api, state.org.id, invoice)),
      onVoid: (invoice) => run(() => voidInvoice(api, state.org.id, invoice)),
    }),
  );
}

function drawOutbox() {
  if (!shell) return;
  mount(shell.outboxSlot, renderOutbox({ messages: state.outbox }));
}

function drawTryIt() {
  if (!shell) return;
  mount(
    shell.tryItSlot,
    renderTryIt({
      busy: state.busy,
      role: state.role,
      onPayDraft: () =>
        run(() =>
          payADraft(api, state.org.id, state.invoices, state.clients[0]?.id),
        ),
      onCreateClient: () =>
        run(() => createClient(api, state.org.id, state.sample++)),
      onPeek: () => run(() => peekAsStranger(api, state.org.id)),
    }),
  );
}

let xrayQueued = false;
/** Redraws the X-ray at most once per frame, however many events just arrived. */
function drawXray() {
  if (xrayQueued) return;
  xrayQueued = true;
  requestAnimationFrame(() => {
    xrayQueued = false;
    if (!shell) return;
    mount(
      shell.xraySlot,
      renderXrayPanel({
        groups: timeline.groups(),
        state: state.stream.state,
        detail: state.stream.detail,
        developer: state.developer,
        isOpen: (key, index) => openCards.get(key) ?? index === 0,
        onToggleCard: (key, open) => openCards.set(key, open),
        onToggleView: (developer) => {
          state.developer = developer;
          drawXray();
        },
        onClear: () => {
          timeline.clear();
          openCards.clear();
          drawXray();
        },
      }),
    );
  });
}

function draw() {
  if (state.phase === 'boot') {
    mount(root);
  } else if (state.phase === 'landing') {
    shell = undefined;
    mount(
      root,
      renderLanding({
        busy: state.starting,
        error: state.startError,
        realAccount: state.realAccount,
        onStart: startDemo,
      }),
    );
  } else {
    shell = renderShell({
      org: state.org,
      role: state.role,
      busy: state.busy,
      onRole: switchRole,
      onNewSandbox: startDemo,
      onSignOut: leave,
    });
    mount(root, shell.root);
    drawInvoices();
    drawOutbox();
    drawTryIt();
    drawXray();
  }
}

// ───────────────────────────── data ─────────────────────────────

/** The emails this sandbox captured. Never fails the page: no outbox just means an empty one. */
async function loadOutbox() {
  try {
    const outbox = await api.request('GET', `/v1/orgs/${state.org.id}/outbox`);
    state.outbox = outbox.data;
  } catch {
    state.outbox = [];
  }
  drawOutbox();
}

/**
 * Refreshes the lists. The outbox is fetched only when asked (first load, and after a send),
 * so the X-ray does not fill with a request for it after every single click.
 * @param {{ outbox?: boolean }} [options]
 */
async function loadData({ outbox = false } = {}) {
  state.loadingInvoices = true;
  drawInvoices();
  const [invoices, clients] = await Promise.all([
    api.request('GET', `/v1/orgs/${state.org.id}/invoices?limit=${LIST_LIMIT}`),
    api.request('GET', `/v1/orgs/${state.org.id}/clients?limit=${LIST_LIMIT}`),
  ]);
  state.invoices = invoices.data;
  state.clients = clients.data;
  state.loadingInvoices = false;
  drawInvoices();
  if (outbox) await loadOutbox();
}

/** Runs one of the buttons: locks the screen, shows what happened, refreshes the list. */
async function run(action, { outbox = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  drawInvoices();
  drawTryIt();
  try {
    toast(await action());
    await loadData({ outbox });
  } catch (error) {
    toast({ tone: 'error', text: 'Something went wrong. Please try again.' });
    console.error(error);
  } finally {
    state.busy = false;
    drawInvoices();
    drawTryIt();
  }
}

// ───────────────────────────── sessions ─────────────────────────────

/** Finds the visitor's company and starts watching it. Called once there is a session. */
async function enter() {
  const orgs = await api.request('GET', '/v1/orgs');
  const org = orgs[0];
  if (!org) throw new Error('This sandbox has no organisation.');
  state.org = { id: org.id, name: org.name };
  state.role = org.role ?? state.role;
  state.invoices = [];
  state.clients = [];
  state.outbox = [];
  timeline.clear();
  openCards.clear();
  state.stream = { state: 'connecting', detail: undefined };
  state.phase = 'app';
  stream?.stop();
  draw();

  stream = startXrayStream({
    url: `/v1/orgs/${org.id}/xray/stream`,
    getToken: () => api.token,
    refreshToken: api.refresh,
    onEvent: (event) => {
      if (timeline.add(event)) drawXray();
    },
    onState: (streamState, detail) => {
      state.stream = { state: streamState, detail };
      drawXray();
    },
  });
  await loadData({ outbox: true });
}

async function startDemo() {
  if (state.starting) return;
  state.starting = true;
  state.startError = '';
  if (state.phase === 'landing') draw();
  try {
    await api.startDemo();
    await enter();
  } catch (error) {
    stream?.stop();
    state.phase = 'landing';
    state.startError = describeStartFailure(error);
    draw();
  } finally {
    state.starting = false;
    if (state.phase === 'landing') draw();
  }
}

/** @param {unknown} error */
function describeStartFailure(error) {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return 'The live demo is switched off right now. Please check back soon.';
    if (error.status === 429)
      return 'A lot of sandboxes were started from your network just now. Wait a few minutes and try again.';
    if (error.status === 503)
      return 'The demo is busy right now. Please try again in a few minutes.';
    if (error.status === 403) return error.message;
  }
  return 'Could not start the demo. Check your connection and try again.';
}

async function switchRole(role) {
  if (state.busy || role === state.role) return;
  state.busy = true;
  draw();
  try {
    await api.switchRole(role);
    state.role = role;
    toast({
      tone: 'ok',
      text: `You are now the ${role.toLowerCase()}. Try the same action again and compare what the X-ray says.`,
    });
    await loadData();
  } catch {
    toast({ tone: 'error', text: 'Could not switch role. Please try again.' });
  } finally {
    state.busy = false;
    draw();
  }
}

async function leave() {
  stream?.stop();
  try {
    await api.request('POST', '/v1/auth/logout');
  } catch {
    // The cookie may already be gone; either way this browser forgets the session.
  }
  api.setToken(undefined);
  state.phase = 'landing';
  draw();
}

// ───────────────────────────── start ─────────────────────────────

async function boot() {
  draw();
  // A visitor who comes back within the sandbox's life is still signed in through the
  // refresh cookie, so they land straight in their own company. Only a DEMO sandbox, though:
  // a real account's company is not a demo (roles cannot be switched, "peek" makes no sense),
  // so it is left alone, not shown.
  try {
    if (await api.refresh()) {
      if (returningVisitor(api.user) === 'demo') {
        await enter();
        return;
      }
      state.realAccount = true;
      api.setToken(undefined); // forget it in this page only; the cookie is untouched
    }
  } catch (error) {
    console.error(error);
  }
  state.phase = 'landing';
  draw();
}

void boot();
