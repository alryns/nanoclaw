/**
 * Validation tests for the configurable idle timeout (#3643):
 * NANOCLAW_IDLE_TIMEOUT_MS → built-in 30-minute default, with an invalid
 * value falling back to the default instead of breaking the sweep.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MIN_IDLE_TIMEOUT_MS,
  parseIdleTimeoutMs,
  resolveIdleTimeoutMs,
} from './idle-timeout.js';

describe('parseIdleTimeoutMs', () => {
  it('accepts integer ms at or above the floor, from number or string', () => {
    expect(parseIdleTimeoutMs(MIN_IDLE_TIMEOUT_MS)).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeoutMs(3_600_000)).toBe(3_600_000);
    expect(parseIdleTimeoutMs('3600000')).toBe(3_600_000);
    expect(parseIdleTimeoutMs(' 3600000 ')).toBe(3_600_000);
    expect(parseIdleTimeoutMs('1e7')).toBe(10_000_000); // scientific notation is still an integer
  });

  it('rejects unset, empty, non-numeric, fractional, and below-floor values', () => {
    expect(parseIdleTimeoutMs(undefined)).toBeUndefined();
    expect(parseIdleTimeoutMs(null)).toBeUndefined();
    expect(parseIdleTimeoutMs('')).toBeUndefined();
    expect(parseIdleTimeoutMs('30 minutes')).toBeUndefined();
    expect(parseIdleTimeoutMs(1.5)).toBeUndefined();
    expect(parseIdleTimeoutMs(0)).toBeUndefined();
    expect(parseIdleTimeoutMs(-1)).toBeUndefined();
    expect(parseIdleTimeoutMs(MIN_IDLE_TIMEOUT_MS - 1)).toBeUndefined();
    expect(parseIdleTimeoutMs(NaN)).toBeUndefined();
    expect(parseIdleTimeoutMs(Infinity)).toBeUndefined();
  });
});

describe('resolveIdleTimeoutMs', () => {
  it('defaults to 30 minutes when the env var is unset or empty', () => {
    expect(resolveIdleTimeoutMs(undefined)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs('')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('uses the env override when it is set', () => {
    expect(resolveIdleTimeoutMs('5400000')).toBe(5_400_000);
  });

  it('falls back to the default when the env override is invalid', () => {
    expect(resolveIdleTimeoutMs('soon')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs('-5')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs(String(MIN_IDLE_TIMEOUT_MS - 1))).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });
});
