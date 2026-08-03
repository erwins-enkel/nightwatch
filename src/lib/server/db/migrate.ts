/**
 * Migrate-on-startup (SPEC §14), run as a script — never imported by the application.
 *
 * Only the `web` service runs this: Compose orders `postgres` (healthy) -> `web` (migrates, then
 * serves) -> `worker`/`watchdog`, so exactly one migrator is ever in flight and no advisory lock
 * is needed. The wait loop below is for operators who point `DATABASE_URL` at their own Postgres
 * and therefore have no Compose healthcheck gating the start.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closePool, getDb, pingDatabase } from './client';
import { createLogger, describeError } from '../logger';
import { synchronisiereVorlagen } from '../regel/db';

const MAX_WAIT_MS = 60_000;
const RETRY_DELAY_MS = 1_000;

const log = createLogger('migrate');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDatabase(): Promise<void> {
	const deadline = Date.now() + MAX_WAIT_MS;
	for (;;) {
		try {
			await pingDatabase();
			return;
		} catch (err) {
			if (Date.now() + RETRY_DELAY_MS >= deadline) {
				throw new Error(`database unreachable after ${MAX_WAIT_MS} ms`, { cause: err });
			}
			log.info('waiting for the database', { error: describeError(err) });
			await delay(RETRY_DELAY_MS);
		}
	}
}

try {
	await waitForDatabase();
	await migrate(getDb(), { migrationsFolder: 'drizzle' });
	log.info('migrations applied');

	// Die kuratierten Regel-Vorlagen kommen mit dem Image und werden „mit Releases aktualisiert"
	// (CONTEXT „Regel-Vorlage"). Hier, weil dieses Skript schon der eine Prozess ist, der beim Start
	// gegen ein frisch migriertes Schema schreibt — ein zweiter Weg bräuchte einen zweiten Lock.
	await synchronisiereVorlagen();
} catch (err) {
	log.error('migration failed', { error: describeError(err) });
	await closePool().catch(() => {});
	process.exit(1);
}

await closePool();
