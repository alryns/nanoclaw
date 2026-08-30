/**
 * Validation tests for the configurable turn ceiling (#3643):
 * NANOCLAW_TURN_CEILING_MS → built-in 30-minute default, with an invalid
 * value falling back to the default instead of breaking the sweep.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TURN_CEILING_MS,
  MIN_TURN_CEILING_MS,
  parseTurnCeilingMs,
  resolveTurnCeilingMs,
} from './turn-ceiling.js';

describe('parseTurnCeilingMs', () => {
  it('accepts integer ms at or above the floor, from number or string', () => {
    expect(parseTurnCeilingMs(MIN_TURN_CEILING_MS)).toBe(MIN_TURN_CEILING_MS);
    expect(parseTurnCeilingMs(3_600_000)).toBe(3_600_000);
    expect(parseTurnCeilingMs('3600000')).toBe(3_600_000);
    expect(parseTurnCeilingMs(' 3600000 ')).toBe(3_600_000);
    expect(parseTurnCeilingMs('1e7')).toBe(10_000_000); // scientific notation is still an integer
  });

  it('rejects unset, empty, non-numeric, fractional, and below-floor values', () => {
    expect(parseTurnCeilingMs(undefined)).toBeUndefined();
    expect(parseTurnCeilingMs(null)).toBeUndefined();
    expect(parseTurnCeilingMs('')).toBeUndefined();
    expect(parseTurnCeilingMs('30 minutes')).toBeUndefined();
    expect(parseTurnCeilingMs(1.5)).toBeUndefined();
    expect(parseTurnCeilingMs(0)).toBeUndefined();
    expect(parseTurnCeilingMs(-1)).toBeUndefined();
    expect(parseTurnCeilingMs(MIN_TURN_CEILING_MS - 1)).toBeUndefined();
    expect(parseTurnCeilingMs(NaN)).toBeUndefined();
    expect(parseTurnCeilingMs(Infinity)).toBeUndefined();
  });
});

describe('resolveTurnCeilingMs', () => {
  it('defaults to 30 minutes when the env var is unset or empty', () => {
    expect(resolveTurnCeilingMs(undefined)).toBe(DEFAULT_TURN_CEILING_MS);
    expect(resolveTurnCeilingMs('')).toBe(DEFAULT_TURN_CEILING_MS);
    expect(DEFAULT_TURN_CEILING_MS).toBe(30 * 60 * 1000);
  });

  it('uses the env override when it is set', () => {
    expect(resolveTurnCeilingMs('5400000')).toBe(5_400_000);
  });

  it('falls back to the default when the env override is invalid', () => {
    expect(resolveTurnCeilingMs('soon')).toBe(DEFAULT_TURN_CEILING_MS);
    expect(resolveTurnCeilingMs('-5')).toBe(DEFAULT_TURN_CEILING_MS);
    expect(resolveTurnCeilingMs(String(MIN_TURN_CEILING_MS - 1))).toBe(DEFAULT_TURN_CEILING_MS);
  });
});
