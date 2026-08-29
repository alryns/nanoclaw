/**
 * Precedence and validation tests for the configurable turn ceiling (#3643):
 * group override → NANOCLAW_TURN_CEILING_MS env → built-in 30-minute default,
 * with invalid values falling through a level instead of breaking the sweep.
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
  it('defaults to 30 minutes when nothing is set', () => {
    expect(resolveTurnCeilingMs(undefined, undefined)).toBe(DEFAULT_TURN_CEILING_MS);
    expect(resolveTurnCeilingMs(null, '')).toBe(DEFAULT_TURN_CEILING_MS);
    expect(DEFAULT_TURN_CEILING_MS).toBe(30 * 60 * 1000);
  });

  it('uses the env override when no group override is set', () => {
    expect(resolveTurnCeilingMs(null, '5400000')).toBe(5_400_000);
  });

  it('prefers the group override over the env override', () => {
    expect(resolveTurnCeilingMs(7_200_000, '5400000')).toBe(7_200_000);
  });

  it('falls back from an invalid group override to the env override', () => {
    expect(resolveTurnCeilingMs(-5, '5400000')).toBe(5_400_000);
    expect(resolveTurnCeilingMs(MIN_TURN_CEILING_MS - 1, '5400000')).toBe(5_400_000);
  });

  it('falls back from invalid group and env overrides to the default', () => {
    expect(resolveTurnCeilingMs(0, 'soon')).toBe(DEFAULT_TURN_CEILING_MS);
  });
});
