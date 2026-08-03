#!/bin/sh
# Role dispatch for the single Nightwatch image.
#
# Only the `web` role migrates: Compose orders postgres (healthy) -> web -> worker/watchdog, so
# exactly one migrator ever runs and no advisory lock is needed (SPEC §14).
set -eu

role="${1:-web}"

case "$role" in
	web)
		bun ./src/lib/server/db/migrate.ts
		exec bun ./build/index.js
		;;
	worker)
		exec bun ./src/worker/index.ts
		;;
	watchdog)
		exec bun ./src/watchdog/index.ts
		;;
	migrate)
		exec bun ./src/lib/server/db/migrate.ts
		;;
	*)
		echo "unknown role: $role (expected web, worker, watchdog or migrate)" >&2
		exit 64
		;;
esac
