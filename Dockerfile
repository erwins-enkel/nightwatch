# One image, three roles (web / worker / watchdog) — see docker/entrypoint.sh.
#
# Alpine rather than slim: BusyBox ships `wget` and `stat`, which the container healthchecks
# need, so no extra packages have to be installed into the runtime image.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
# `bun run build` compiles the Paraglide messages and bundles the SvelteKit server into build/.
RUN bun run build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: the SvelteKit bundle keeps `dependencies` external, and the
# worker/watchdog entrypoints run straight from source.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/build ./build
COPY src ./src
COPY drizzle ./drizzle
COPY docker/entrypoint.sh ./docker/entrypoint.sh

# `bun` is the non-root user shipped with the base image (SPEC §12 container hardening).
USER bun

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 3000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["web"]
