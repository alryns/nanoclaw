/**
 * Wiring test for the install-wide turn ceiling: NANOCLAW_TURN_CEILING_MS
 * really reaches the sweep's ABSOLUTE_CEILING_MS, so an install on a slow
 * local-model backend stops cold-killing containers mid-turn (#3643).
 *
 * The ceiling is resolved at module load, so each case re-imports the module
 * with the env var stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TURN_CEILING_MS } from './turn-ceiling.js';

async function loadSweepWith(envValue?: string) {
  vi.resetModules();
  if (envValue === undefined) vi.stubEnv('NANOCLAW_TURN_CEILING_MS', '');
  else vi.stubEnv('NANOCLAW_TURN_CEILING_MS', envValue);
  return import('./host-sweep.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('NANOCLAW_TURN_CEILING_MS', () => {
  it('defaults to 30 minutes when unset', async () => {
    const { ABSOLUTE_CEILING_MS } = await loadSweepWith(undefined);
    expect(ABSOLUTE_CEILING_MS).toBe(DEFAULT_TURN_CEILING_MS);
  });

  it('raises the ceiling the sweep kills on', async () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const { ABSOLUTE_CEILING_MS, decideStuckAction } = await loadSweepWith(String(twoHrMs));
    expect(ABSOLUTE_CEILING_MS).toBe(twoHrMs);

    const now = Date.parse('2026-04-20T12:00:00.000Z');
    // 45 min quiet: killed under the built-in default, alive under a 2h ceiling.
    expect(
      decideStuckAction({
        now,
        heartbeatMtimeMs: now - 45 * 60 * 1000,
        containerState: null,
        claims: [],
      }).action,
    ).toBe('ok');
    expect(
      decideStuckAction({
        now,
        heartbeatMtimeMs: now - (twoHrMs + 1),
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'kill-ceiling', heartbeatAgeMs: twoHrMs + 1, ceilingMs: twoHrMs });
  });

  it('falls back to the default for an invalid or below-floor value', async () => {
    expect((await loadSweepWith('soon')).ABSOLUTE_CEILING_MS).toBe(DEFAULT_TURN_CEILING_MS);
    expect((await loadSweepWith('1000')).ABSOLUTE_CEILING_MS).toBe(DEFAULT_TURN_CEILING_MS);
  });
});
