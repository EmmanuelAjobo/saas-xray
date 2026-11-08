# Going live on Railway

A step-by-step for the first deploy: the API, Postgres and Redis in one Railway project, with Swagger as the public face. Railway's screens change from time to time; if a label differs, look for the closest one. Check Railway's current pricing before you start: the trial credit runs out.

**Before you start:** the code must be pushed to GitHub (you push it yourself), and CI should be green.

## 1. Create the project

1. [railway.com](https://railway.com) → sign in with GitHub → **New Project** → **Deploy from GitHub repo** → choose `saas-xray`.
2. Railway finds the `Dockerfile` and builds from it. The first build takes several minutes. It may fail or crash-loop until the variables below are set; that is expected.

## 2. Add the databases

In the same project: **+ New** → **Database** → **PostgreSQL**, then **+ New** → **Database** → **Redis**. Both appear as services next to the API.

## 3. Give the API a public address (do this before the variables)

Open the API service → **Settings** → **Networking** → **Generate Domain**. You get something like `https://saas-xray-production.up.railway.app`. Copy it: you need it for `WEB_ORIGIN`.

## 4. Set the variables

API service → **Variables**. Railway's `${{Service.VAR}}` syntax pulls values from the other services, so no password is ever copied by hand. (If your services are not named `Postgres` and `Redis`, use their actual names.)

| Variable               | Value                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `production`                                                                                                               |
| `DATABASE_URL`         | `${{Postgres.DATABASE_URL}}`                                                                                               |
| `REDIS_URL`            | `${{Redis.REDIS_URL}}`                                                                                                     |
| `JWT_ACCESS_SECRET`    | Run `openssl rand -base64 48` on your machine and paste the result. Never reuse the example value.                         |
| `WEB_ORIGIN`           | The domain from step 3, with `https://` and no trailing slash. **It must be the API's own address** until a web app exists |
| `ERROR_DOCS_BASE_URL`  | `https://<your-domain>/docs/errors`                                                                                        |
| `TRUST_PROXY_HOPS`     | `1`                                                                                                                        |
| `MAIL_DRIVER`          | `resend` (once you have a key; see step 6)                                                                                 |
| `RESEND_API_KEY`       | From Resend                                                                                                                |
| `MAIL_FROM`            | `"SaaS X-ray <hello@yourdomain.com>"` on a domain verified in Resend                                                       |
| `TURNSTILE_SECRET_KEY` | Optional but recommended (step 7)                                                                                          |

Why `WEB_ORIGIN` is the API's own address: the sign-in cookie endpoints accept browser requests only from `WEB_ORIGIN`. Swagger runs on the API's address, so that is the origin its requests carry. When the real web app arrives, change `WEB_ORIGIN` to the web app's origin.

Everything else has a safe default. Railway redeploys when variables change.

## 5. Health check and migrations

- Service → **Settings** → **Healthcheck Path**: `/health/ready`.
- Migrations need no setup: the container applies pending ones every time it starts. One instance is enough; with several, Prisma's database lock stops them from clashing.

## 6. Email (Resend)

1. [resend.com](https://resend.com) → create an API key → paste it as `RESEND_API_KEY`.
2. To send to anyone other than yourself you must **verify a domain** (add the DNS records Resend shows you). Without one, Resend only delivers to your own address, so real sign-ups could not receive their verification email.
3. Demo accounts never need email (demo organisations don't send it), so the demo button works before the domain is verified.

## 7. Protect the demo button (recommended)

Public endpoints that create data attract bots. Cloudflare Turnstile is free: Cloudflare dashboard → **Turnstile** → add a widget → copy the **secret key** into `TURNSTILE_SECRET_KEY`. With it set, `POST /v1/auth/demo` requires a valid challenge token, so only add it when you have a page that can show the Turnstile widget; Swagger alone cannot. Until then, leave it unset: the demo is already limited per IP and by `DEMO_MAX_ACTIVE`.

## 8. Check that it works

Replace `$API` with your domain:

```bash
curl https://$API/health/ready                          # postgres and redis "up"
curl -X POST https://$API/v1/auth/demo -H 'content-type: application/json' -d '{}'   # an accessToken
```

Then open `https://$API/docs`, click **Authorize**, paste the token, and try `GET /v1/orgs`. Run `npm run demo:stolen-token` against it with `API_URL=https://$API npm run demo:stolen-token -- --allow-remote` if you want to prove the theft detection live (it creates a throwaway account).

## 9. A custom domain (when you buy one)

Service → **Settings** → **Networking** → **Custom Domain** → enter `api.yourdomain.com` → add the DNS record Railway shows at your registrar. Then update `WEB_ORIGIN`, `ERROR_DOCS_BASE_URL` and `MAIL_FROM` to match, and verify the domain in Resend.

The sign-in cookie is `SameSite=Lax`, so the future web app must live under the same registrable domain (`app.yourdomain.com` next to `api.yourdomain.com`).

## If something fails

| You see                                      | Look at                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Deploy crash-loops                           | The service **Logs**. The first lines say which variable is missing or invalid; the app prints one clear message. |
| `JWT_ACCESS_SECRET` error                    | It still starts with `change-me`, or is under 32 characters.                                                      |
| Health check keeps failing                   | Is `DATABASE_URL` / `REDIS_URL` the `${{...}}` reference to the right service name?                               |
| Swagger sign-in works but refresh gives 403  | `WEB_ORIGIN` does not match the address in your browser bar (check `https`, no trailing slash).                   |
| Rate limits hit everyone at once             | `TRUST_PROXY_HOPS` is `0`; it must be `1` behind Railway.                                                         |
