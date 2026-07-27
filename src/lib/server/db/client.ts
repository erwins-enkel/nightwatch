import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { requireDatabaseUrl } from '../env';
import * as schema from './schema';

/**
 * Shared connection pool. `pg` (node-postgres) is deliberately the only Postgres driver in the
 * tree — pg-boss uses it too, so there is one driver to reason about and to keep patched.
 *
 * Created on first use, not at import: SvelteKit's post-build analyse step imports every server
 * module, and a build must not need a database.
 */
let poolInstance: pg.Pool | undefined;

export function getPool(): pg.Pool {
	return (poolInstance ??= new pg.Pool({ connectionString: requireDatabaseUrl() }));
}

let dbInstance: ReturnType<typeof createDb> | undefined;

function createDb(pool: pg.Pool) {
	return drizzle(pool, { schema });
}

export function getDb(): ReturnType<typeof createDb> {
	return (dbInstance ??= createDb(getPool()));
}

/** No-op if nothing ever connected, so shutdown paths can call it unconditionally. */
export async function closePool(): Promise<void> {
	const pool = poolInstance;
	if (!pool) return;
	poolInstance = undefined;
	dbInstance = undefined;
	await pool.end();
}

export type Database = ReturnType<typeof getDb>;
