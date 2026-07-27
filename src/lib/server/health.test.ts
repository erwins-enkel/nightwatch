import { describe, expect, it } from 'vitest';
import { evaluateHealth, type HeartbeatSnapshot } from './health';

const now = new Date('2026-07-27T12:00:00.000Z');
const secondsAgo = (seconds: number) => new Date(now.getTime() - seconds * 1000);

function snapshot(dienst: string, seconds: number): HeartbeatSnapshot {
	return { dienst, zuletztGesehen: secondsAgo(seconds), version: '1.2.3' };
}

const base = { now, staleAfterMs: 60_000, version: '1.2.3', databaseReachable: true };

describe('evaluateHealth', () => {
	it('reports ok with all three services fresh', () => {
		const report = evaluateHealth({
			...base,
			rows: [snapshot('web', 1), snapshot('worker', 2), snapshot('watchdog', 3)]
		});

		expect(report.status).toBe('ok');
		expect(report.services.map((service) => service.stale)).toEqual([false, false, false]);
	});

	it('marks a service stale once it exceeds the threshold', () => {
		const report = evaluateHealth({
			...base,
			rows: [snapshot('web', 1), snapshot('worker', 61), snapshot('watchdog', 60)]
		});

		expect(report.services.find((service) => service.dienst === 'worker')?.stale).toBe(true);
		// Exactly at the threshold is still fresh.
		expect(report.services.find((service) => service.dienst === 'watchdog')?.stale).toBe(false);
	});

	it('reports a service that never wrote a heartbeat as stale, not as missing', () => {
		const report = evaluateHealth({ ...base, rows: [snapshot('web', 1)] });

		const worker = report.services.find((service) => service.dienst === 'worker');
		expect(worker).toEqual({ dienst: 'worker', zuletztGesehen: null, version: null, stale: true });
	});

	it('stays ok while other services are stale', () => {
		// Otherwise a cold start would deadlock: worker and watchdog wait for `web: service_healthy`.
		const report = evaluateHealth({ ...base, rows: [snapshot('web', 1)] });

		expect(report.status).toBe('ok');
	});

	it('is degraded only when the database is unreachable', () => {
		const report = evaluateHealth({ ...base, rows: [], databaseReachable: false });

		expect(report.status).toBe('degraded');
	});
});
