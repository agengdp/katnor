import { customType } from 'drizzle-orm/pg-core';

/**
 * pgvector `vector(n)` column type, implemented by hand via drizzle's
 * `customType` rather than importing a `vector()` helper directly from
 * `drizzle-orm/pg-core`.
 *
 * Why: drizzle-orm has, at various points, shipped a built-in `vector`
 * column helper for pgvector support, but this file was written with no
 * registry access to install drizzle-orm@^0.38.0 and confirm its exact
 * export name / config signature (e.g. whether it is `vector(name, {
 * dimensions })` or something else) against the real published package.
 * Rather than guess and risk a subtly wrong import, this reimplements the
 * same column type on top of `customType`, a small, stable, long-lived
 * drizzle-orm API:
 *   - `dataType` supplies the Postgres column type declaration:
 *     `vector(<dimensions>)`.
 *   - `toDriver` serializes a JS `number[]` into pgvector's text input
 *     format on write (e.g. `[0.1,0.2,0.3]`).
 *   - `fromDriver` parses that same text format back into a `number[]`
 *     when a row is read back.
 *
 * This requires `CREATE EXTENSION IF NOT EXISTS vector;` to have been run
 * against the target database first - see src/applyPostMigrate.ts, which
 * runs that statement before anything else, idempotently.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    const dimensions = config?.dimensions;
    if (!dimensions) {
      throw new Error(
        'vector column requires a `dimensions` config, e.g. vector("embedding", { dimensions: 1536 })',
      );
    }
    return `vector(${dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    const trimmed = value.trim();
    const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    if (inner.length === 0) return [];
    return inner.split(',').map(Number);
  },
});
