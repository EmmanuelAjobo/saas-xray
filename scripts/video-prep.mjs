#!/usr/bin/env node
/**
 * Prepares everything you need OFF-camera for the founder demo video, so the on-camera steps
 * are short and nothing can go wrong in front of the viewer.
 *
 *   npm run demo:prep
 *
 * It (idempotently, so it is safe to run again) makes a real account, an organisation and a
 * client, prints the access token and ready-to-paste request bodies, and empties the Mailpit
 * inbox so the first email on camera is the one you send.
 *
 * It refuses to run against anything but a local server, because it creates accounts.
 *
 * Options:   --keep-mail     leave the Mailpit inbox alone
 *            --allow-remote  allow a non-local API_URL (be sure that is what you want)
 * Settings (environment, all optional):
 *   API_URL (http://localhost:3000)   MAILPIT_URL (http://localhost:8025)
 *   PREP_EMAIL, PREP_PASSWORD, PREP_ORG_NAME, PREP_CLIENT_NAME, PREP_CLIENT_EMAIL
 */

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const MAILPIT = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(
  /\/+$/,
  '',
);
const EMAIL = process.env.PREP_EMAIL ?? 'founder.demo@example.com';
// A throwaway local-only password for a throwaway local account.
const PASSWORD = process.env.PREP_PASSWORD ?? 'a long founder passphrase';
const ORG_NAME = process.env.PREP_ORG_NAME ?? 'Acme Studio';
const CLIENT_NAME = process.env.PREP_CLIENT_NAME ?? 'Northwind Traders';
const CLIENT_EMAIL =
  process.env.PREP_CLIENT_EMAIL ?? 'billing@northwind.example';

const args = new Set(process.argv.slice(2));
const colour = process.stdout.isTTY
  ? (code) => (text) => `\x1b[${code}m${text}\x1b[0m`
  : () => (text) => text;
const green = colour(32);
const red = colour(31);
const dim = colour(2);
const bold = colour(1);

function fail(message) {
  console.error(`${red('✗')} ${message}`);
  process.exit(1);
}

function assertLocal(url) {
  const { hostname } = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  if (!local && !args.has('--allow-remote')) {
    fail(
      `API_URL is ${url}, which is not a local server. This script creates accounts, so it ` +
        'only runs locally. Pass --allow-remote if you really mean it.',
    );
  }
}

async function call(method, path, { token, body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(
      `Cannot reach ${API}. Start the app first:  npm run start:dev  (wait for "API listening").`,
    );
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, body: json };
}

function step(label) {
  console.log(`${green('✓')} ${label}`);
}

async function main() {
  assertLocal(API);
  console.log(bold('\nPreparing the demo video\n'));

  const health = await call('get', '/health/ready');
  if (health.status !== 200) {
    fail(
      'The app is running but not ready (is Postgres up?). Try:  docker compose up -d --wait',
    );
  }
  step('App is up and ready');

  // 1. Account: register, or log in if it already exists.
  let session = await call('post', '/v1/auth/register', {
    body: { email: EMAIL, password: PASSWORD, name: 'Founder Demo' },
  });
  if (session.status === 201) {
    step(`Created account ${EMAIL}`);
  } else if (session.status === 409) {
    session = await call('post', '/v1/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });
    if (session.status !== 200) {
      fail(
        `${EMAIL} already exists with a different password. Set PREP_EMAIL / PREP_PASSWORD, or use another email.`,
      );
    }
    step(`Logged in to existing account ${EMAIL}`);
  } else {
    fail(
      `Could not create the account (HTTP ${session.status}): ${session.body?.detail ?? 'unknown error'}`,
    );
  }
  const token = session.body.accessToken;

  // 2. Organisation.
  const orgs = await call('get', '/v1/orgs', { token });
  let org = orgs.body?.find?.((o) => o.name === ORG_NAME);
  if (org) {
    step(`Organisation "${ORG_NAME}" already exists`);
  } else {
    const created = await call('post', '/v1/orgs', {
      token,
      body: { name: ORG_NAME },
    });
    if (created.status !== 201) {
      fail(
        `Could not create the organisation (HTTP ${created.status}): ${created.body?.detail ?? ''}`,
      );
    }
    org = created.body;
    step(`Created organisation "${ORG_NAME}"`);
  }

  // 3. Client.
  const found = await call(
    'get',
    `/v1/orgs/${org.id}/clients?q=${encodeURIComponent(CLIENT_EMAIL)}`,
    { token },
  );
  let client = found.body?.data?.find?.((c) => c.email === CLIENT_EMAIL);
  if (client) {
    step(`Client "${client.name}" already exists`);
  } else {
    const created = await call('post', `/v1/orgs/${org.id}/clients`, {
      token,
      body: { name: CLIENT_NAME, email: CLIENT_EMAIL },
    });
    if (created.status !== 201) {
      fail(
        `Could not create the client (HTTP ${created.status}): ${created.body?.detail ?? ''}`,
      );
    }
    client = created.body;
    step(`Created client "${CLIENT_NAME}"`);
  }

  // 4. A clean inbox, so the first email on camera is the invoice you send.
  if (args.has('--keep-mail')) {
    console.log(`${dim('·')} Left the Mailpit inbox alone (--keep-mail)`);
  } else {
    try {
      const cleared = await fetch(`${MAILPIT}/api/v1/messages`, {
        method: 'DELETE',
      });
      if (cleared.ok) step('Emptied the Mailpit inbox');
      else
        console.log(
          `${dim('·')} Could not empty Mailpit (HTTP ${cleared.status}); do it by hand`,
        );
    } catch {
      console.log(
        `${dim('·')} Mailpit is not reachable at ${MAILPIT}; skipped`,
      );
    }
  }

  const invoiceBody = {
    clientId: client.id,
    items: [
      {
        description: 'Website design (hours)',
        quantity: 10,
        unitPriceCents: 9500,
      },
      { description: 'Hosting', quantity: 3, unitPriceCents: 1200 },
    ],
  };

  console.log(`
${bold('Ready. For Swagger (http://localhost:3000/docs):')}

  1. Click Authorize and paste this access token ${dim('(valid 15 minutes; re-run this script for a fresh one)')}:
     ${token}

  2. Organisation id (the {orgId} in the URLs):
     ${org.id}

  3. POST /v1/orgs/{orgId}/invoices   ${dim('(paste as the body)')}
${JSON.stringify(invoiceBody, null, 2)
  .split('\n')
  .map((line) => `     ${line}`)
  .join('\n')}

  4. Then POST /v1/orgs/{orgId}/invoices/{id}/send and watch ${MAILPIT}

${bold('On camera, in this order:')} demo button → create + send invoice (email lands in Mailpit)
→ pay a DRAFT (409) → switch role to MEMBER (403) → second visitor gets 404 → stolen-token proof
${dim('(npm run demo:stolen-token)')}.
`);
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
