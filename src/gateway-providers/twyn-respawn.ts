/**
 * TwynOracle's bounded recovery for a container that died while work is due.
 *
 * The runner calls this after it has completed its normal exit bookkeeping.
 * Imports stay lazy because this module is reached while the runner is part of
 * the gateway provider initialization cycle.
 */
import type { SessionFailure } from '../drivers/types.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

const CRASH_RESPAWN_DELAY_MS = 5_000;
const CRASH_RESPAWN_CAP_MS = 10 * 60 * 1_000;

const lastScheduledAt = new Map<string, number>();
const scheduledTimers = new Set<NodeJS.Timeout>();

export interface SessionExit {
  sessionId: string;
  failure?: SessionFailure;
  stopReason?: string;
}

async function getSessionWithDueWork(sessionId: string): Promise<Session | undefined> {
  const { getSession } = await import('../db/sessions.js');
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return undefined;

  const { withExistingMailboxSession } = await import('../session-manager.js');
  const hasDueWork =
    (await withExistingMailboxSession(
      session.agent_group_id,
      sessionId,
      (mailbox) => mailbox.countDueMessages() > 0,
    )) ?? false;
  return hasDueWork ? session : undefined;
}

async function scheduleCrashRespawn(sessionId: string, exitCode: number): Promise<void> {
  const session = await getSessionWithDueWork(sessionId);
  if (!session) return;

  const now = Date.now();
  const previous = lastScheduledAt.get(sessionId);
  if (previous !== undefined && now - previous < CRASH_RESPAWN_CAP_MS) {
    log.warn('Crash respawn skipped (cap)', { sessionId, exitCode });
    return;
  }

  lastScheduledAt.set(sessionId, now);
  const timer = setTimeout(() => {
    scheduledTimers.delete(timer);
    void import('../request-wake.js')
      .then(({ requestWake }) => requestWake(session, 'due-message'))
      .catch((err: unknown) => log.error('Crash respawn wake failed', { sessionId, exitCode, err }));
  }, CRASH_RESPAWN_DELAY_MS);
  scheduledTimers.add(timer);
  timer.unref();
  log.info('Crash respawn scheduled', { sessionId, exitCode });
}

/** Observe a runner exit without participating in its finalization path. */
export function onSessionExited({ sessionId, failure, stopReason }: SessionExit): void {
  if (stopReason || failure?.kind !== 'started-then-died' || !failure.exitCode) return;
  void scheduleCrashRespawn(sessionId, failure.exitCode).catch((err: unknown) => {
    log.error('Crash respawn scheduling failed', { sessionId, exitCode: failure.exitCode, err });
  });
}

/** Test seam for the host-local cap and unref'd timers. */
export function _resetTwynRespawnForTesting(): void {
  lastScheduledAt.clear();
  for (const timer of scheduledTimers) clearTimeout(timer);
  scheduledTimers.clear();
}
