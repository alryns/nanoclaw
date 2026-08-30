/**
 * Turn-ceiling resolution — how long a running container's heartbeat may go
 * quiet before the host sweep kills it.
 *
 * The 30-minute built-in default encodes hosted-inference latency: a frontier
 * provider emits stream events far more often than that. A slow local-model
 * backend (MLX / llama.cpp / Ollama on consumer hardware) can legitimately
 * spend longer than 30 minutes actively decoding one turn, so the ceiling can
 * be raised install-wide with `NANOCLAW_TURN_CEILING_MS` — while the default
 * stays exactly what it always was (#3643).
 *
 * Kept free of host-sweep imports so this stays a leaf module.
 */

// Absolute idle ceiling default for a running container (30 minutes).
export const DEFAULT_TURN_CEILING_MS = 30 * 60 * 1000;
// Anything below the sweep interval + claim tolerance would kill containers
// on their first quiet tick; refuse ceilings shorter than one minute.
export const MIN_TURN_CEILING_MS = 60 * 1000;

/**
 * Parse the raw env value into ms. Returns undefined for anything that is not
 * a finite integer >= MIN_TURN_CEILING_MS, so a typo'd env var falls back to
 * the default instead of disabling the ceiling or collapsing it to NaN.
 */
export function parseTurnCeilingMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MIN_TURN_CEILING_MS) return undefined;
  return n;
}

/** Effective turn ceiling: NANOCLAW_TURN_CEILING_MS → built-in default. */
export function resolveTurnCeilingMs(envRaw?: string): number {
  return parseTurnCeilingMs(envRaw) ?? DEFAULT_TURN_CEILING_MS;
}
