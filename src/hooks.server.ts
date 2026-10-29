import type { Handle, ServerInit } from '@sveltejs/kit';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { getTextDirection } from '$lib/paraglide/runtime';
import { env } from '$lib/server/env';
import { createLogger, describeError } from '$lib/server/logger';
import { startHeartbeat } from '$lib/server/heartbeat';
import { startWatchdogTimer } from '$lib/server/watchdog-timer';
import { writeHeartbeat } from '$lib/server/db/heartbeat';

const log = createLogger('web');

/** Runs once per server process, before the first request is handled. */
export const init: ServerInit = () => {
	const watchdog = startWatchdogTimer({
		name: 'web',
		timeoutMs: env.watchdogTimeoutMs,
		livenessFile: env.livenessFile
	});

	startHeartbeat({
		intervalMs: env.heartbeatIntervalMs,
		write: () => writeHeartbeat('web'),
		onTick: () => watchdog.pet(),
		onError: (err) => log.warn('heartbeat write failed', { error: describeError(err) })
	});

	log.info('web ready', { version: env.appVersion });
};

export const handle: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request: localizedRequest, locale }) => {
		event.request = localizedRequest;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
		});
	});
