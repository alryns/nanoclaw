/**
 * Wiring tests for the sweep-side turn-ceiling resolution: the central-DB
 * read behind `groupTurnCeilingMs` really carries a group's
 * `turn_ceiling_ms` override into the resolved value, and the per-tick cache
 * honors the no-restart apply semantic — a config change is visible exactly
 * after the cache clears (one sweep interval), not mid-tick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { DEFAULT_TURN_CEILING_MS } from './turn-ceiling.js';
import { _clearTurnCeilingCacheForTesting, groupTurnCeilingMs } from './host-sweep.js';

const GROUP = 'ag-ceiling-test';

describe('groupTurnCeilingMs', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    _clearTurnCeilingCacheForTesting();
    await createAgentGroup({
      id: GROUP,
      name: GROUP,
      folder: GROUP,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig(GROUP);
  });
  afterEach(async () => {
    _clearTurnCeilingCacheForTesting();
    await closeDb();
  });

  it('resolves to the default when the group has no override', async () => {
    expect(await groupTurnCeilingMs(GROUP)).toBe(DEFAULT_TURN_CEILING_MS);
  });

  it('carries a stored group override into the resolved ceiling', async () => {
    await updateContainerConfigScalars(GROUP, { turn_ceiling_ms: 7_200_000 });
    expect(await groupTurnCeilingMs(GROUP)).toBe(7_200_000);
  });

  it('an invalid stored override falls back instead of breaking the sweep', async () => {
    await updateContainerConfigScalars(GROUP, { turn_ceiling_ms: -5 });
    expect(await groupTurnCeilingMs(GROUP)).toBe(DEFAULT_TURN_CEILING_MS);
  });

  it('caches within a tick and picks up a config change after the per-tick clear', async () => {
    await updateContainerConfigScalars(GROUP, { turn_ceiling_ms: 7_200_000 });
    expect(await groupTurnCeilingMs(GROUP)).toBe(7_200_000);

    // Changed mid-tick: the cached value holds (one read per group per tick).
    await updateContainerConfigScalars(GROUP, { turn_ceiling_ms: 3_600_000 });
    expect(await groupTurnCeilingMs(GROUP)).toBe(7_200_000);

    // The sweep clears the cache at the top of each tick — the change lands
    // on the next tick, which is the documented staleness bound.
    _clearTurnCeilingCacheForTesting();
    expect(await groupTurnCeilingMs(GROUP)).toBe(3_600_000);
  });

  it('a missing config row resolves to the default rather than throwing', async () => {
    expect(await groupTurnCeilingMs('ag-no-such-group')).toBe(DEFAULT_TURN_CEILING_MS);
  });
});
