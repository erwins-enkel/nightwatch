/**
 * Runtime configuration, read straight from `process.env`.
 *
 * This module is imported by the SvelteKit server *and* by the standalone worker/watchdog
 * entrypoints, which Bun runs outside of SvelteKit. It must therefore never reach for
 * `$env/*` or `$app/*` — those only exist inside a SvelteKit build.
 */

function positiveSeconds(name: string, raw: string | undefined, fallbackSeconds: number): number {
	if (raw === undefined || raw.trim() === '') return fallbackSeconds * 1000;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number of seconds, got ${JSON.stringify(raw)}`);
	}
	return Math.round(parsed * 1000);
}

/**
 * Read at first connection rather than at import: SvelteKit's post-build analyse step imports
 * every server module, and a build must not require a database to be configured.
 */
export function requireDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is not set — see .env.example');
	return databaseUrl;
}

const heartbeatIntervalMs = positiveSeconds(
	'HEARTBEAT_INTERVAL_SECONDS',
	process.env.HEARTBEAT_INTERVAL_SECONDS,
	15
);

export const env = {
	appVersion: process.env.APP_VERSION?.trim() || 'dev',
	heartbeatIntervalMs,
	/**
	 * A service counts as stale once it has missed four heartbeats in a row. Derived rather than
	 * separately configurable, so the two values can never drift apart.
	 */
	heartbeatStaleAfterMs: heartbeatIntervalMs * 4,
	watchdogTimeoutMs: positiveSeconds(
		'WATCHDOG_TIMEOUT_SECONDS',
		process.env.WATCHDOG_TIMEOUT_SECONDS,
		90
	),
	/**
	 * How often the worker looks for mailboxes that are due. Not the poll interval itself — that is
	 * per mailbox (`postfach.poll_intervall_sekunden`, 60–300 s per SPEC §3). This only bounds how
	 * late a due mailbox can be picked up, so it stays well below the shortest interval.
	 */
	ingestionTickMs: positiveSeconds(
		'INGESTION_TICK_SECONDS',
		process.env.INGESTION_TICK_SECONDS,
		15
	),
	/**
	 * How often the worker looks for mails the assignment has not placed yet. Well below the
	 * shortest poll interval, so a freshly ingested mail is assigned within seconds rather than
	 * waiting out an ingestion cycle it has nothing to do with.
	 */
	zuordnungTickMs: positiveSeconds(
		'ZUORDNUNG_TICK_SECONDS',
		process.env.ZUORDNUNG_TICK_SECONDS,
		10
	),
	/** Touched on every main-loop tick; the container healthcheck reads its mtime. */
	livenessFile: process.env.LIVENESS_FILE?.trim() || '/tmp/nightwatch-alive'
} as const;
