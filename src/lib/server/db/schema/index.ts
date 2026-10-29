/**
 * The Nightwatch data model (SPEC §10), split by domain. Everything is re-exported here so that
 * `import … from './schema'` keeps working and `drizzle(pool, { schema })` sees every table.
 *
 * Conventions across all modules: table and column names are snake_case German terms from
 * CONTEXT.md with umlauts written out (`zaehler`, `uebergang`); TypeScript keys are camelCase;
 * surrogate keys are `uuid` with a database-side default; every point in time is `timestamptz`.
 */
export * from './enums';
export * from './postfach';
export * from './kunde';
export * from './monitor';
export * from './mail';
export * from './alarm';
export * from './system';
