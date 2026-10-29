import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/env';
import { evaluateHealth, type HeartbeatSnapshot } from '$lib/server/health';
import { readHeartbeats } from '$lib/server/db/heartbeat';
import { createLogger, describeError } from '$lib/server/logger';

const log = createLogger('web');

/**
 * Passive health endpoint (SPEC §8): it reports, it does not act. No writes, no jobs queued,
 * nothing scheduled — safe to poll as often as a Docker healthcheck or an uptime probe likes.
 */
export const GET: RequestHandler = async () => {
	let rows: HeartbeatSnapshot[] = [];
	let databaseReachable = true;

	try {
		rows = await readHeartbeats();
	} catch (err) {
		databaseReachable = false;
		log.warn('health check could not reach the database', { error: describeError(err) });
	}

	const report = evaluateHealth({
		rows,
		now: new Date(),
		staleAfterMs: env.heartbeatStaleAfterMs,
		version: env.appVersion,
		databaseReachable
	});

	return json(report, {
		status: report.status === 'ok' ? 200 : 503,
		headers: { 'cache-control': 'no-store' }
	});
};
