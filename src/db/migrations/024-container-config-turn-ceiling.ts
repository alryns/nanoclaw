import type { Migration } from './index.js';

/**
 * Per-agent-group turn-ceiling override on `container_configs`.
 *
 * Milliseconds; NULL = follow the install default (NANOCLAW_TURN_CEILING_MS
 * env var, or the built-in 30 minutes). Lets a group pinned to a slow local
 * model raise the host sweep's absolute idle ceiling without loosening it
 * for every other group (#3643).
 *
 * No backfill: existing rows stay NULL (= install default), reproducing
 * pre-migration behavior exactly.
 *
 * Unlike sibling 020 (same ALTER TABLE ADD COLUMN shape), this migration
 * does NOT declare `sqliteOnly`: 020 predates the portability boundary and
 * lives in the frozen SQLite-only set, while every post-boundary migration
 * must be portable — ADD COLUMN with a plain INTEGER type is, and
 * portability.test.ts enforces the split.
 */
export const migration024: Migration = {
  version: 24,
  name: 'container-config-turn-ceiling',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN turn_ceiling_ms INTEGER;`);
  },
};
