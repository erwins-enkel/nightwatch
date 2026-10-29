/** The three Node services that write heartbeats. Postgres is covered by `databaseReachable`. */
export const SERVICES = ['web', 'worker', 'watchdog'] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface HeartbeatSnapshot {
	dienst: string;
	zuletztGesehen: Date;
	version: string;
}

export interface ServiceHealth {
	dienst: ServiceName;
	zuletztGesehen: string | null;
	version: string | null;
	stale: boolean;
}

export interface HealthReport {
	status: 'ok' | 'degraded';
	version: string;
	services: ServiceHealth[];
}

export interface EvaluateHealthInput {
	rows: HeartbeatSnapshot[];
	now: Date;
	staleAfterMs: number;
	version: string;
	databaseReachable: boolean;
}

/**
 * Builds the `/health` payload. Pure, so the interesting part is unit-testable without a
 * database or an HTTP server.
 *
 * The status code deliberately tracks *only* this process plus the database. Whether the other
 * services are stale is reported in the body but must not make the web service unhealthy:
 * worker and watchdog wait for `web: service_healthy` via `depends_on`, so folding their
 * heartbeats into the status would deadlock a cold start — nobody would ever come up.
 */
export function evaluateHealth(input: EvaluateHealthInput): HealthReport {
	const { rows, now, staleAfterMs, version, databaseReachable } = input;
	const byService = new Map(rows.map((row) => [row.dienst, row]));

	return {
		status: databaseReachable ? 'ok' : 'degraded',
		version,
		services: SERVICES.map((dienst) => {
			const row = byService.get(dienst);
			return {
				dienst,
				zuletztGesehen: row ? row.zuletztGesehen.toISOString() : null,
				version: row ? row.version : null,
				stale: !row || now.getTime() - row.zuletztGesehen.getTime() > staleAfterMs
			};
		})
	};
}
