#!/usr/bin/env node
/**
 * The stolen-token proof, with clean labelled output for the video.
 *
 *   npm run demo:stolen-token
 *
 * It signs up a throwaway user, then plays out an attack on their login session:
 *
 *   1. the real user refreshes their session            → works (200)
 *   2. an attacker replays the OLD copied token          → refused (401)
 *   3. the real user's newest token is now dead as well  → refused (401): the whole session
 *      was shut down the moment the theft was detected.
 *
 * It exits with a non-zero code if the server does not behave this way, so it doubles as a
 * quick check. Local servers only (it creates an account).
 *
 * Options:   --fast          no pauses between steps (the default pauses so viewers can read)
 *            --allow-remote  allow a non-local API_URL
 * Setting:   API_URL (http://localhost:3000)
 */

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const args = new Set(process.argv.slice(2));
const PAUSE_MS = args.has('--fast') ? 0 : 1500;

const colour = process.stdout.isTTY
  ? (code) => (text) => `\x1b[${code}m${text}\x1b[0m`
  : () => (text) => text;
const green = colour(32);
const red = colour(31);
const dim = colour(2);
const bold = colour(1);
const yellow = colour(33);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`${red('✗')} ${message}`);
  process.exit(1);
}

const { hostname } = new URL(API);
if (
  !['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname) &&
  !args.has('--allow-remote')
) {
  fail(
    `API_URL is ${API}, which is not local. This script creates an account; pass --allow-remote if you mean it.`,
  );
}

/** The refresh cookie as a browser would send it back: "refresh_token=<value>". */
function refreshCookieFrom(response) {
  const line = response.headers
    .getSetCookie()
    .find((c) => c.startsWith('refresh_token='));
  return line?.split(';')[0];
}

async function post(path, { cookie, body } = {}) {
  try {
    return await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return fail(
      `Cannot reach ${API}. Start the app first:  npm run start:dev  (wait for "API listening").`,
    );
  }
}

let failures = 0;
async function expectStatus(label, response, wanted, meaning) {
  const ok = response.status === wanted;
  if (!ok) failures++;
  const mark = ok ? green('✓') : red('✗');
  const code = ok
    ? green(String(response.status))
    : red(`${response.status} (expected ${wanted})`);
  console.log(`   ${mark} ${label.padEnd(44)} ${bold(code)}  ${dim(meaning)}`);
  await sleep(PAUSE_MS);
}

async function main() {
  console.log(bold('\nStolen login token: what happens?\n'));

  const email = `stolen-token-demo.${Date.now()}@example.com`;
  const signup = await post('/v1/auth/register', {
    body: { email, password: 'a long throwaway passphrase', name: 'Real User' },
  });
  if (signup.status !== 201) {
    fail(
      `Could not create the throwaway user (HTTP ${signup.status}). Is the app running and the rate limit not exhausted?`,
    );
  }
  const original = refreshCookieFrom(signup);
  if (!original) fail('The server did not set a refresh cookie.');

  console.log(`${green('✓')} A real user signs in ${dim(`(${email})`)}`);
  await sleep(PAUSE_MS);
  console.log(
    `${yellow('!')} An attacker copies their refresh token ${dim('(XSS, a stolen laptop, a leaked log...)')}\n`,
  );
  await sleep(PAUSE_MS);

  // 1. The real user refreshes: works, and the token is rotated.
  const refreshed = await post('/v1/auth/refresh', { cookie: original });
  await expectStatus(
    'Real user refreshes their session',
    refreshed,
    200,
    'works; the old token is retired',
  );
  const newest = refreshCookieFrom(refreshed);
  if (!newest) fail('The refresh did not rotate the cookie.');

  // 2. The attacker replays the token they copied (now retired).
  const replay = await post('/v1/auth/refresh', { cookie: original });
  await expectStatus(
    'Attacker replays the copied (old) token',
    replay,
    401,
    'refused, and the theft is detected',
  );

  // 3. Because a retired token was reused, the whole session is shut down.
  const afterwards = await post('/v1/auth/refresh', { cookie: newest });
  await expectStatus(
    "Real user's newest token",
    afterwards,
    401,
    'also dead: the whole session was revoked',
  );

  if (failures > 0) {
    console.log(
      `\n${red('✗')} ${failures} step(s) did not behave as expected.\n`,
    );
    process.exit(1);
  }
  console.log(
    `\n${green('✓')} ${bold('Theft detected, session shut down.')} ` +
      `${dim('The real user simply signs in again; the attacker is locked out.')}\n`,
  );
  console.log(
    dim(
      `(Throwaway account ${email} stays in your local database; it is harmless.)\n`,
    ),
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
