const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

function configuredLevel(): LogLevel {
	const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
	if (!raw) return 'info';
	if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
		throw new Error(
			`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(raw)}`
		);
	}
	return raw as LogLevel;
}

/**
 * Minimal structured logger: one JSON object per line, on stdout (stderr for errors) — what
 * `docker compose logs` and every log shipper expect.
 *
 * `LOG_LEVEL` is read here rather than in `env.ts` so that this module stays free of
 * import-time requirements and can be used from anywhere, including plain utilities.
 *
 * Never pass secrets in `fields`: SPEC §12 keeps credentials out of logs entirely.
 */
export function createLogger(service: string): Logger {
	const threshold = SEVERITY[configuredLevel()];

	function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
		if (SEVERITY[level] < threshold) return;
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			level,
			service,
			message,
			...fields
		});
		if (level === 'error') console.error(line);
		else console.log(line);
	}

	return {
		debug: (message, fields) => emit('debug', message, fields),
		info: (message, fields) => emit('info', message, fields),
		warn: (message, fields) => emit('warn', message, fields),
		error: (message, fields) => emit('error', message, fields)
	};
}

/** Turns an unknown thrown value into something safe to put in a log field. */
export function describeError(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
