/**
 * TwynOracle's host-local admission controls for gateway-backed agent spawns.
 *
 * This module deliberately reaches the container runner, session store, and wake
 * seam lazily. Its registration is imported by twyn-copilot while the runner is
 * importing the gateway registry, so eager runtime imports would close that
 * initialization cycle. The functions below only need those bindings at spawn
 * or drain time.
 */
import fs from 'fs';

import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { log } from '../log.js';

const DEFAULT_MAX_RUNNING_AGENTS = 4;
const DEFAULT_SPAWN_BACKOFF_MAX_MS = 5 * 60 * 1000;
const SPAWN_BACKOFF_BASE_MS = 5 * 1000;
const IN_FLIGHT_TTL_MS = 60 * 1000;
const WAITING_DRAIN_INTERVAL_MS = 5 * 1000;
const DEFAULT_IDLE_EVICT_MIN_MS = 60 * 1000;
const RUNNING_SUCCESS_MIN_MS = 10 * 1000;

interface SpawnAttempt {
  admittedAt: number;
  /** Number of previously admitted attempts that never became a runtime. */
  consecutiveNonRunningAttempts: number;
}

const admittedButNotRunning = new Map<string, number>();
// Deliberately host-local: containers adopted after a host restart cannot be
// distinguished cheaply here, so only runs this process admitted are evictable.
const admittedSessionIds = new Set<string>();
const attempts = new Map<string, SpawnAttempt>();
const waitingSessionIds: string[] = [];
const waitingSet = new Set<string>();
const waitingLogged = new Set<string>();
let waitingDrainTimer: NodeJS.Timeout | null = null;

function nonNegativeEnvInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function maxRunningAgents(): number {
  return nonNegativeEnvInt(process.env.TWYN_MAX_RUNNING_AGENTS, DEFAULT_MAX_RUNNING_AGENTS);
}

function spawnBackoffMaxMs(): number {
  return nonNegativeEnvInt(process.env.TWYN_SPAWN_BACKOFF_MAX_MS, DEFAULT_SPAWN_BACKOFF_MAX_MS);
}

function idleEvictMinMs(): number {
  return nonNegativeEnvInt(process.env.TWYN_IDLE_EVICT_MIN_MS, DEFAULT_IDLE_EVICT_MIN_MS);
}

function enqueueWaiting(sessionId: string): void {
  if (!waitingSet.has(sessionId)) {
    waitingSet.add(sessionId);
    waitingSessionIds.push(sessionId);
  }
  if (!waitingLogged.has(sessionId)) {
    waitingLogged.add(sessionId);
    log.warn('Twyn running cap reached; session stays pending', { sessionId, maxRunningAgents: maxRunningAgents() });
  }
}

function dropInFlightAdmission(sessionId: string): void {
  admittedButNotRunning.delete(sessionId);
}

function resetSuccessfulRun(sessionId: string): void {
  dropInFlightAdmission(sessionId);
  attempts.delete(sessionId);
  waitingLogged.delete(sessionId);
}

async function isSuccessfulRun(
  sessionId: string,
  now: number,
  getContainerStartedAtMs: (sessionId: string) => number | undefined,
): Promise<boolean> {
  const startedAtMs = getContainerStartedAtMs(sessionId);
  if (startedAtMs !== undefined && now - startedAtMs >= RUNNING_SUCCESS_MIN_MS) return true;

  const { getSession } = await import('../db/sessions.js');
  const session = await getSession(sessionId);
  if (!session) return false;
  const { heartbeatPath } = await import('../session-manager.js');
  return fs.existsSync(heartbeatPath(session.agent_group_id, sessionId));
}

async function pruneAdmissionState(now: number): Promise<{
  activeCount: number;
  isContainerRunning: (sessionId: string) => boolean;
}> {
  const { getActiveContainerCount, getContainerStartedAtMs, isContainerRunning } =
    await import('../container-runner.js');
  for (const [sessionId, admittedAt] of admittedButNotRunning) {
    if (isContainerRunning(sessionId)) {
      // A short-lived container has reached the runtime registry, which frees
      // the in-flight cap reservation, but it has not earned a backoff reset.
      dropInFlightAdmission(sessionId);
      if (await isSuccessfulRun(sessionId, now, getContainerStartedAtMs)) resetSuccessfulRun(sessionId);
    } else if (now - admittedAt >= IN_FLIGHT_TTL_MS) {
      admittedButNotRunning.delete(sessionId);
    }
  }
  return { activeCount: getActiveContainerCount(), isContainerRunning };
}

function backoffMs(attempt: SpawnAttempt): number {
  return Math.min(SPAWN_BACKOFF_BASE_MS * Math.pow(2, attempt.consecutiveNonRunningAttempts), spawnBackoffMaxMs());
}

/**
 * Admit one spawn at the gateway contribution seam. Throws so upstream leaves
 * the inbound row pending for its normal reconciliation path.
 */
export async function admitSpawn(sessionId: string): Promise<void> {
  const now = Date.now();
  const { activeCount, isContainerRunning } = await pruneAdmissionState(now);

  if (isContainerRunning(sessionId)) {
    const { getContainerStartedAtMs } = await import('../container-runner.js');
    dropInFlightAdmission(sessionId);
    if (await isSuccessfulRun(sessionId, now, getContainerStartedAtMs)) resetSuccessfulRun(sessionId);
    return;
  }

  const previous = attempts.get(sessionId);
  if (previous) {
    const waitMs = backoffMs(previous);
    const elapsedMs = now - previous.admittedAt;
    if (elapsedMs < waitMs) {
      throw new Error(`twyn spawn backoff: session ${sessionId} must wait ${waitMs - elapsedMs}ms`);
    }
  }

  const maximum = maxRunningAgents();
  const admittedCount = admittedButNotRunning.size;
  if (maximum !== 0 && activeCount + admittedCount >= maximum) {
    enqueueWaiting(sessionId);
    throw new Error(
      `twyn running cap reached (${activeCount + admittedCount}/${maximum}): session ${sessionId} stays pending`,
    );
  }

  admittedButNotRunning.set(sessionId, now);
  admittedSessionIds.add(sessionId);
  attempts.set(sessionId, {
    admittedAt: now,
    // The first retry waits five seconds. Each later admission that still
    // never became a container doubles the following wait, capped by env.
    consecutiveNonRunningAttempts: previous ? previous.consecutiveNonRunningAttempts + 1 : 0,
  });
}

interface IdleEvictionCandidate {
  sessionId: string;
  heartbeatMs: number;
}

async function evictOneIdleSession(waitingSessionId: string): Promise<void> {
  const { getContainerStartedAtMs, isContainerRunning, killContainer } = await import('../container-runner.js');
  const { getSession } = await import('../db/sessions.js');
  const { heartbeatPath, withExistingMailboxSession } = await import('../session-manager.js');
  const now = Date.now();
  const minimumAgeMs = idleEvictMinMs();
  let victim: IdleEvictionCandidate | null = null;

  for (const sessionId of admittedSessionIds) {
    if (!isContainerRunning(sessionId)) continue;
    const session = await getSession(sessionId);
    if (!session) {
      admittedSessionIds.delete(sessionId);
      continue;
    }

    const hasProcessingClaim = await withExistingMailboxSession(
      session.agent_group_id,
      sessionId,
      (mailbox) => mailbox.getProcessingClaims().length > 0,
    );
    // A missing mailbox cannot prove the container is idle, so retain it.
    if (hasProcessingClaim !== false) continue;

    let heartbeatMs: number;
    /* eslint-disable no-catch-all/no-catch-all -- a missing heartbeat deliberately falls back to container start time */
    try {
      heartbeatMs = fs.statSync(heartbeatPath(session.agent_group_id, sessionId)).mtimeMs;
    } catch {
      heartbeatMs = getContainerStartedAtMs(sessionId) ?? 0;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (heartbeatMs === 0 || now - heartbeatMs < minimumAgeMs) continue;
    if (!victim || heartbeatMs < victim.heartbeatMs) victim = { sessionId, heartbeatMs };
  }

  if (!victim) return;
  killContainer(victim.sessionId, `twyn-idle-evict: slot needed by ${waitingSessionId}`);
  log.info('Evicting idle Twyn agent container for waiting session', {
    sessionId: victim.sessionId,
    waitingSessionId,
    heartbeatAgeMs: now - victim.heartbeatMs,
  });
}

/**
 * Wake queued sessions fairly as capacity becomes free. The cap and this five
 * second tick bound starts per hour; no second rate limiter is necessary.
 */
export async function drainWaitingSessions(): Promise<void> {
  const maximum = maxRunningAgents();
  const { activeCount, isContainerRunning } = await pruneAdmissionState(Date.now());
  let currentCount = activeCount + admittedButNotRunning.size;

  if (waitingSessionIds.length > 0 && maximum !== 0 && currentCount >= maximum) {
    await evictOneIdleSession(waitingSessionIds[0]);
    return;
  }

  while (waitingSessionIds.length > 0 && (maximum === 0 || currentCount < maximum)) {
    const sessionId = waitingSessionIds.shift();
    if (!sessionId) return;
    waitingSet.delete(sessionId);

    if (isContainerRunning(sessionId)) {
      dropInFlightAdmission(sessionId);
      currentCount = activeCount + admittedButNotRunning.size;
      continue;
    }

    const { getSession } = await import('../db/sessions.js');
    const session = await getSession(sessionId);
    if (!session) {
      waitingLogged.delete(sessionId);
      continue;
    }

    const { requestWake } = await import('../request-wake.js');
    await requestWake(session, 'due-message');
    currentCount = activeCount + admittedButNotRunning.size;
  }
}

onHostStart(() => {
  if (waitingDrainTimer) return;
  waitingDrainTimer = setInterval(() => {
    void drainWaitingSessions();
  }, WAITING_DRAIN_INTERVAL_MS);
  waitingDrainTimer.unref();
});

onHostShutdown(() => {
  if (!waitingDrainTimer) return;
  clearInterval(waitingDrainTimer);
  waitingDrainTimer = null;
});

/** Test seam for provider-local state only. */
export function _resetTwynLifecycleForTesting(): void {
  admittedButNotRunning.clear();
  admittedSessionIds.clear();
  attempts.clear();
  waitingSessionIds.length = 0;
  waitingSet.clear();
  waitingLogged.clear();
  if (waitingDrainTimer) clearInterval(waitingDrainTimer);
  waitingDrainTimer = null;
}
