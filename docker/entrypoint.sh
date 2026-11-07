#!/bin/sh
# Container start-up: apply database migrations, then run the command (the API by default).
#
# `prisma migrate deploy` only applies migrations that are not applied yet, and takes a
# database lock, so two containers starting at once cannot run the same migration twice.
# It never creates a migration and never resets data (that is `migrate dev`, development only).
#
# Set RUN_MIGRATIONS=false to skip it, for example when your platform runs migrations as a
# separate release step. This variable is read here, not by the app, so it is not in the
# env schema.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Applying database migrations..."
  npx prisma migrate deploy
fi

# exec: the app becomes PID 1's replacement and receives SIGTERM directly, so the
# graceful-shutdown hooks run when the platform stops the container.
exec "$@"
