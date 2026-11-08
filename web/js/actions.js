// @ts-check
import { ApiError } from './api.js';

/**
 * What happened when the visitor tried something, in words for a non-technical reader.
 * `tone` picks the colour: ok (it worked), refused (the backend said no, which is the
 * point of the demo) or error (something actually went wrong).
 * @typedef {{ tone: 'ok' | 'refused' | 'error', text: string }} Outcome
 *
 * The slice of the API client these actions need (so tests can pass a fake).
 * @typedef {{
 *   request: (method: string, path: string, options?: any) => Promise<any>,
 *   stranger: () => Promise<{ accessToken: string }>,
 * }} Api
 */

/** Line items for the sample invoices, rotated so each new invoice differs. */
const SAMPLE_ITEMS = [
  [
    {
      description: 'Website design (hours)',
      quantity: 10,
      unitPriceCents: 9500,
    },
    { description: 'Hosting', quantity: 3, unitPriceCents: 1200 },
  ],
  [
    { description: 'Logo and brand kit', quantity: 1, unitPriceCents: 150000 },
    { description: 'Revision rounds', quantity: 2, unitPriceCents: 25000 },
  ],
  [{ description: 'Monthly retainer', quantity: 1, unitPriceCents: 240000 }],
  [
    { description: 'Copywriting (pages)', quantity: 8, unitPriceCents: 8000 },
    { description: 'Photography', quantity: 1, unitPriceCents: 45000 },
  ],
];

/**
 * @param {string} clientId
 * @param {number} n which sample to use (wraps around)
 */
export function sampleInvoice(clientId, n) {
  return { clientId, items: SAMPLE_ITEMS[n % SAMPLE_ITEMS.length] };
}

/**
 * Runs an action and turns any failure into a sentence, so the screen never has to know
 * about HTTP. A 4xx is the backend doing its job ("refused"); anything else is a real error.
 * @param {() => Promise<string>} run returns the success message
 * @returns {Promise<Outcome>}
 */
export async function attempt(run) {
  try {
    return { tone: 'ok', text: await run() };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status >= 400 && error.status < 500 && error.status !== 401) {
        return {
          tone: 'refused',
          text: `Refused (${error.status}): ${error.message}`,
        };
      }
      return {
        tone: 'error',
        text: `Something went wrong (${error.status}): ${error.message}`,
      };
    }
    return {
      tone: 'error',
      text: 'Could not reach the server. Check your connection and try again.',
    };
  }
}

/** @param {Api} api @param {string} orgId @param {string} clientId @param {number} n */
export function createInvoice(api, orgId, clientId, n) {
  return attempt(async () => {
    const invoice = await api.request('POST', `/v1/orgs/${orgId}/invoices`, {
      body: sampleInvoice(clientId, n),
    });
    return `Invoice ${invoice.number} created as a draft. The server worked out the total and the number; the screen never sent them.`;
  });
}

/** @param {Api} api @param {string} orgId @param {{ id: string, number: string }} invoice */
export function sendInvoice(api, orgId, invoice) {
  return attempt(async () => {
    await api.request('POST', `/v1/orgs/${orgId}/invoices/${invoice.id}/send`);
    return `${invoice.number} sent. In a demo sandbox no real email goes out; the X-ray says so.`;
  });
}

/** @param {Api} api @param {string} orgId @param {{ id: string, number: string }} invoice */
export function payInvoice(api, orgId, invoice) {
  return attempt(async () => {
    await api.request('POST', `/v1/orgs/${orgId}/invoices/${invoice.id}/pay`);
    return `${invoice.number} marked as paid.`;
  });
}

/** @param {Api} api @param {string} orgId @param {{ id: string, number: string }} invoice */
export function voidInvoice(api, orgId, invoice) {
  return attempt(async () => {
    await api.request('POST', `/v1/orgs/${orgId}/invoices/${invoice.id}/void`);
    return `${invoice.number} voided.`;
  });
}

/**
 * "Pay a draft": the invoice rules live on the server, so even a button that asks for the
 * impossible gets a clear refusal. Uses an existing draft, or makes one first.
 * @param {Api} api
 * @param {string} orgId
 * @param {Array<{ id: string, number: string, status: string }>} invoices
 * @param {string | undefined} clientId used to make a draft when there is none
 */
export function payADraft(api, orgId, invoices, clientId) {
  return attempt(async () => {
    let draft = invoices.find((invoice) => invoice.status === 'DRAFT');
    if (!draft) {
      if (!clientId)
        throw new ApiError(409, {
          detail: 'There is no client to invoice yet.',
        });
      draft = await api.request('POST', `/v1/orgs/${orgId}/invoices`, {
        body: { clientId },
      });
    }
    await api.request('POST', `/v1/orgs/${orgId}/invoices/${draft?.id}/pay`);
    return 'The server paid a draft invoice. That should not be possible; please report it.';
  });
}

/** @param {Api} api @param {string} orgId @param {number} n */
export function createClient(api, orgId, n) {
  return attempt(async () => {
    const client = await api.request('POST', `/v1/orgs/${orgId}/clients`, {
      body: {
        name: `Sample Client ${n}`,
        email: `sample-client-${n}-${Date.now()}@example.com`,
      },
    });
    return `Client "${client.name}" created.`;
  });
}

/**
 * "Peek at another company": a second visitor, with their own private sandbox, asks for THIS
 * visitor's data. The answer is a 404, the same as for a company that does not exist, so a
 * stranger cannot even tell whether it is real.
 * @param {Api} api
 * @param {string} orgId
 */
export async function peekAsStranger(api, orgId) {
  try {
    const stranger = await api.stranger();
    await api.request('GET', `/v1/orgs/${orgId}/invoices`, {
      bearer: stranger.accessToken,
    });
    return /** @type {Outcome} */ ({
      tone: 'error',
      text: 'A stranger could read this company’s invoices. That should never happen; please report it.',
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return /** @type {Outcome} */ ({
        tone: 'refused',
        text: 'A stranger from another company got 404: "not found". The server answers exactly the same for "no such company" and "not yours", and nothing appears in your X-ray, because strangers leave no trace.',
      });
    }
    if (error instanceof ApiError && error.status === 429) {
      return /** @type {Outcome} */ ({
        tone: 'error',
        text: 'Too many demo sandboxes were started from here just now. Wait a little and try again.',
      });
    }
    return /** @type {Outcome} */ ({
      tone: 'error',
      text: 'Could not set up the stranger’s sandbox. Try again in a moment.',
    });
  }
}
