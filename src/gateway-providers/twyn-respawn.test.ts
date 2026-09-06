import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dueMessages, requestWake, sessions } = vi.hoisted(() => ({
  dueMessages: new Map<string, number>(),
  requestWake: vi.fn().mockResolvedValue(true),
  sessions: new Map<string, { id: string; agent_group_id: string; status: 'active' }>(),
}));

vi.mock('../db/sessions.js', () => ({
  getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
}));
vi.mock('../request-wake.js', () => ({ requestWake }));
vi.mock('../session-manager.js', () => ({
  withExistingMailboxSession: async (
    _agentGroupId: string,
    sessionId: string,
    action: (mailbox: { countDueMessages(): number }) => boolean,
  ) => action({ countDueMessages: () => dueMessages.get(sessionId) ?? 0 }),
}));

import { log } from '../log.js';
import { _resetTwynRespawnForTesting, onSessionExited } from './twyn-respawn.js';

function registerSession(sessionId = 'session-1'): void {
  sessions.set(sessionId, { id: sessionId, agent_group_id: 'group-1', status: 'active' });
}

function crash(sessionId = 'session-1', exitCode = 137): void {
  onSessionExited({ sessionId, failure: { kind: 'started-then-died', retryable: false, exitCode } });
}

beforeEach(() => {
  vi.useFakeTimers();
  dueMessages.clear();
  requestWake.mockClear();
  sessions.clear();
  _resetTwynRespawnForTesting();
});

afterEach(() => {
  _resetTwynRespawnForTesting();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Twyn crash respawn', () => {
  it('schedules a due session after a non-zero exit', async () => {
    registerSession();
    dueMessages.set('session-1', 1);

    crash();
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestWake).toHaveBeenCalledWith(sessions.get('session-1'), 'due-message');
  });

  it('does not schedule an exit code zero', async () => {
    registerSession();
    dueMessages.set('session-1', 1);

    crash('session-1', 0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestWake).not.toHaveBeenCalled();
  });

  it('does not schedule when no inbound work is due', async () => {
    registerSession();

    crash();
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestWake).not.toHaveBeenCalled();
  });

  it('enforces one automatic respawn per session within ten minutes', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    registerSession();
    dueMessages.set('session-1', 1);

    crash();
    await vi.advanceTimersByTimeAsync(0);
    crash();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Crash respawn skipped (cap)', { sessionId: 'session-1', exitCode: 137 });
  });

  it('unrefs the crash-respawn timer', async () => {
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setTimeoutSpy = vi
      .spyOn(global, 'setTimeout')
      .mockImplementation(((_callback: () => void) => timer) as typeof setTimeout);
    registerSession();
    dueMessages.set('session-1', 1);

    crash();
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(timer.unref).toHaveBeenCalledOnce();
  });
});
