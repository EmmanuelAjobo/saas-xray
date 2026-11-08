# Production image for the API. Build:  docker build -t saas-xray .
#
# Two stages:
#   build    installs everything, generates the Prisma client and compiles TypeScript
#   runtime  only production dependencies + the compiled output, running as a non-root user
#
# Node 24 is required (the app uses the built-in crypto.argon2, added in 24.7), so the tag is
# pinned to the 24 line. -slim (Debian) rather than alpine: fewer surprises with native code.

FROM node:24-slim AS build
WORKDIR /app

# Dependencies first, so this slow layer is cached until package files change.
# Scripts are skipped here and the client is generated explicitly below, once the schema is
# in place, so editing the schema does not re-download every dependency.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npm run build


FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma's migration engine needs OpenSSL, which the slim image does not include.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# `prisma` is a production dependency so the container can run `prisma migrate deploy`
# before it starts (see docker/entrypoint.sh). Installing WITH scripts downloads its engine
# now, at build time, so nothing is downloaded (or written to node_modules) at runtime,
# where we run as a non-root user. The schema must exist first: the postinstall script
# (`prisma generate`) reads it. The app itself uses the client compiled into dist/.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# The demo page: plain static files, served by the API at /.
COPY web ./web
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

# Never run as root inside the container.
USER node

# Hosts inject PORT; the app reads it. 3000 is only the documentation default.
EXPOSE 3000

# Liveness only: it must not depend on Postgres/Redis, or a database blip would make the
# platform restart a perfectly healthy API in a loop. Readiness is /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
