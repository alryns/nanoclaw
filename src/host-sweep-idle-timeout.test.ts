/**
 * Wiring test for the install-wide idle timeout: NANOCLAW_IDLE_TIMEOUT_MS
 * really reaches the sweep's IDLE_TIMEOUT_MS, so an install on a slow
 * local-model backend stops cold-killing containers that are still working
 * but quiet (#3643).
 *
 * The timeout is resolved at module load, so each case re-imports the module
 * with the env var stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_IDLE_TIMEOUT_MS } from './idle-timeout.js';

async function loadSweepWith(envValue?: string) {
  vi.resetModules();
  if (envValue === undefined) vi.stubEnv('NANOCLAW_IDLE_TIMEOUT_MS', '');
  else vi.stubEnv('NANOCLAW_IDLE_TIMEOUT_MS', envValue);
  return import('./host-sweep.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('NANOCLAW_IDLE_TIMEOUT_MS', () => {
  it('defaults to 30 minutes when unset', async () => {
    const { IDLE_TIMEOUT_MS } = await loadSweepWith(undefined);
    expect(IDLE_TIMEOUT_MS).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('raises the silence the sweep tolerates before killing', async () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const { IDLE_TIMEOUT_MS, decideStuckAction } = await loadSweepWith(String(twoHrMs));
    expect(IDLE_TIMEOUT_MS).toBe(twoHrMs);

    const now = Date.parse('2026-04-20T12:00:00.000Z');
    // 45 min silent: killed under the built-in default, alive under a 2h timeout.
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
    ).toEqual({ action: 'kill-idle-timeout', heartbeatAgeMs: twoHrMs + 1, idleTimeoutMs: twoHrMs });
  });

  it('falls back to the default for an invalid or below-floor value', async () => {
    expect((await loadSweepWith('soon')).IDLE_TIMEOUT_MS).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect((await loadSweepWith('1000')).IDLE_TIMEOUT_MS).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });
});
