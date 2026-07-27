import { getDb } from './client';
import { heartbeat } from './schema';
import { env } from '../env';
import type { HeartbeatSnapshot, ServiceName } from '../health';

/** Close enough to this process' start: the module is imported during service startup. */
const gestartetAm = new Date();

/** Upsert — one row per service, so the table stays at three rows forever. */
export async function writeHeartbeat(dienst: ServiceName): Promise<void> {
	const row = {
		dienst,
		zuletztGesehen: new Date(),
		gestartetAm,
		version: env.appVersion,
		pid: process.pid
	};
	await getDb()
		.insert(heartbeat)
		.values(row)
		.onConflictDoUpdate({ target: heartbeat.dienst, set: row });
}

export async function readHeartbeats(): Promise<HeartbeatSnapshot[]> {
	return getDb()
		.select({
			dienst: heartbeat.dienst,
			zuletztGesehen: heartbeat.zuletztGesehen,
			version: heartbeat.version
		})
		.from(heartbeat);
}
