import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  activeCount,
  heartbeatRoot,
  killContainer,
  processingClaims,
  requestWake,
  runningSessions,
  sessions,
  startedAtMs,
} = vi.hoisted(() => ({
  activeCount: { value: 0 },
  heartbeatRoot: `/tmp/twyn-lifecycle-${process.pid}`,
  killContainer: vi.fn(),
  processingClaims: new Map<string, number>(),
  runningSessions: new Set<string>(),
  requestWake: vi.fn().mockResolvedValue(true),
  sessions: new Map<string, { id: string; agent_group_id: string }>(),
  startedAtMs: new Map<string, number>(),
}));

vi.mock('../container-runner.js', () => ({
  getActiveContainerCount: () => activeCount.value,
  getContainerStartedAtMs: (sessionId: string) => startedAtMs.get(sessionId),
  isContainerRunning: (sessionId: string) => runningSessions.has(sessionId),
  killContainer,
}));
vi.mock('../db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => sessions.get(id) ?? (id === 'missing' ? undefined : { id })),
}));
vi.mock('../request-wake.js', () => ({ requestWake }));
vi.mock('../session-manager.js', () => ({
  heartbeatPath: (agentGroupId: string, sessionId: string) => `${heartbeatRoot}/${agentGroupId}/${sessionId}.heartbeat`,
  withExistingMailboxSession: async (
    _agentGroupId: string,
    sessionId: string,
    action: (mailbox: { getProcessingClaims(): Array<unknown> }) => boolean,
  ) => action({ getProcessingClaims: () => Array.from({ length: processingClaims.get(sessionId) ?? 0 }) }),
}));

import { getHostStartCallbacks, stopHostModules } from '../host-lifecycle.js';
import { _resetTwynLifecycleForTesting, admitSpawn, drainWaitingSessions, maxRunningAgents } from './twyn-lifecycle.js';

function registerSession(sessionId: string, agentGroupId = 'group-1'): void {
  sessions.set(sessionId, { id: sessionId, agent_group_id: agentGroupId });
}

function writeHeartbeat(agentGroupId: string, sessionId: string, heartbeatMs: number): void {
  const file = path.join(heartbeatRoot, agentGroupId, `${sessionId}.heartbeat`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.utimesSync(file, heartbeatMs / 1000, heartbeatMs / 1000);
}

async function admitRunning(sessionId: string): Promise<void> {
  registerSession(sessionId);
  await admitSpawn(sessionId);
  runningSessions.add(sessionId);
}

beforeEach(() => {
  vi.useFakeTimers();
  activeCount.value = 0;
  killContainer.mockClear();
  processingClaims.clear();
  runningSessions.clear();
  requestWake.mockClear();
  sessions.clear();
  startedAtMs.clear();
  fs.rmSync(heartbeatRoot, { recursive: true, force: true });
  _resetTwynLifecycleForTesting();
  vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '4');
  vi.stubEnv('TWYN_SPAWN_BACKOFF_MAX_MS', '300000');
  vi.stubEnv('TWYN_IDLE_EVICT_MIN_MS', '60000');
});

afterEach(async () => {
  _resetTwynLifecycleForTesting();
  await stopHostModules();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(heartbeatRoot, { recursive: true, force: true });
});

describe('Twyn running lifecycle', () => {
  it('admits a spawn under the running cap', async () => {
    await expect(admitSpawn('one')).resolves.toBeUndefined();
  });

  it('refuses at the cap and leaves the session queued', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '1');
    activeCount.value = 1;
    await expect(admitSpawn('one')).rejects.toThrow('twyn running cap reached (1/1): session one stays pending');
  });

  it('counts in-flight admissions before the runner has registered them', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '1');
    await admitSpawn('one');
    await expect(admitSpawn('two')).rejects.toThrow('twyn running cap reached (1/1): session two stays pending');
  });

  it('prunes an in-flight admission once the runner observes it running', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '1');
    await admitSpawn('one');
    runningSessions.add('one');
    await expect(admitSpawn('two')).resolves.toBeUndefined();
  });

  it('drains waiting sessions in FIFO order on the host timer', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '1');
    activeCount.value = 1;
    await expect(admitSpawn('first')).rejects.toThrow(/cap reached/);
    await expect(admitSpawn('second')).rejects.toThrow(/cap reached/);
    activeCount.value = 0;
    requestWake.mockImplementation(async (session: { id: string }) => {
      await admitSpawn(session.id);
      return true;
    });

    const lifecycleStart = getHostStartCallbacks().at(-1);
    expect(lifecycleStart).toBeDefined();
    await lifecycleStart?.({} as never);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(requestWake).toHaveBeenLastCalledWith({ id: 'first' }, 'due-message');

    runningSessions.add('first');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestWake).toHaveBeenCalledTimes(2);
    expect(requestWake).toHaveBeenLastCalledWith({ id: 'second' }, 'due-message');
  });

  it('backs off repeated non-running spawn attempts, grows, then resets on running', async () => {
    await admitSpawn('one');
    await expect(admitSpawn('one')).rejects.toThrow(/must wait 5000ms/);

    await vi.advanceTimersByTimeAsync(5_000);
    await admitSpawn('one');
    await expect(admitSpawn('one')).rejects.toThrow(/must wait 10000ms/);

    runningSessions.add('one');
    startedAtMs.set('one', Date.now() - 10_000);
    await expect(admitSpawn('one')).resolves.toBeUndefined();
    runningSessions.delete('one');
    await expect(admitSpawn('one')).resolves.toBeUndefined();
    await expect(admitSpawn('one')).rejects.toThrow(/must wait 5000ms/);
  });

  it('retains the doubled backoff after a one-second running sighting then terminal exit', async () => {
    await admitSpawn('one');
    await vi.advanceTimersByTimeAsync(5_000);
    await admitSpawn('one');
    runningSessions.add('one');
    startedAtMs.set('one', Date.now() - 1_000);

    await expect(admitSpawn('one')).resolves.toBeUndefined();
    runningSessions.delete('one');

    await expect(admitSpawn('one')).rejects.toThrow(/must wait 10000ms/);
  });

  it('resets the backoff after a container has run for ten seconds', async () => {
    await admitSpawn('one');
    runningSessions.add('one');
    startedAtMs.set('one', Date.now() - 10_000);

    await expect(admitSpawn('one')).resolves.toBeUndefined();
    runningSessions.delete('one');
    await expect(admitSpawn('one')).resolves.toBeUndefined();
  });

  it('resets the backoff when the runner wrote a heartbeat', async () => {
    registerSession('one');
    await admitSpawn('one');
    runningSessions.add('one');
    startedAtMs.set('one', Date.now() - 1_000);
    writeHeartbeat('group-1', 'one', Date.now());

    await expect(admitSpawn('one')).resolves.toBeUndefined();
    runningSessions.delete('one');
    await expect(admitSpawn('one')).resolves.toBeUndefined();
  });

  it('caps exponential backoff with TWYN_SPAWN_BACKOFF_MAX_MS', async () => {
    vi.stubEnv('TWYN_SPAWN_BACKOFF_MAX_MS', '7500');
    await admitSpawn('one');
    await vi.advanceTimersByTimeAsync(5_000);
    await admitSpawn('one');
    await expect(admitSpawn('one')).rejects.toThrow(/must wait 7500ms/);
  });

  it('treats cap zero as unlimited', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '0');
    activeCount.value = 100;
    await expect(admitSpawn('one')).resolves.toBeUndefined();
    await expect(admitSpawn('two')).resolves.toBeUndefined();
    expect(maxRunningAgents()).toBe(0);
  });

  it('drops an in-flight admission after sixty seconds', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '1');
    await admitSpawn('one');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(admitSpawn('two')).resolves.toBeUndefined();
  });

  it('evicts the oldest idle heartbeat when a waiter needs a saturated slot', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '2');
    await admitRunning('oldest');
    await admitRunning('newer');
    activeCount.value = 2;
    const now = Date.now();
    writeHeartbeat('group-1', 'oldest', now - 120_000);
    writeHeartbeat('group-1', 'newer', now - 90_000);
    await expect(admitSpawn('waiting')).rejects.toThrow(/cap reached/);

    await drainWaitingSessions();

    expect(killContainer).toHaveBeenCalledWith('oldest', 'twyn-idle-evict: slot needed by waiting');
  });

  it('never evicts a session with a processing claim', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '2');
    await admitRunning('claimed');
    await admitRunning('idle');
    activeCount.value = 2;
    const now = Date.now();
    writeHeartbeat('group-1', 'claimed', now - 120_000);
    writeHeartbeat('group-1', 'idle', now - 90_000);
    processingClaims.set('claimed', 1);
    await expect(admitSpawn('waiting')).rejects.toThrow(/cap reached/);

    await drainWaitingSessions();

    expect(killContainer).toHaveBeenCalledWith('idle', 'twyn-idle-evict: slot needed by waiting');
  });

  it('never evicts a session younger than the idle minimum', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '1');
    await admitRunning('young');
    activeCount.value = 1;
    writeHeartbeat('group-1', 'young', Date.now() - 59_999);
    await expect(admitSpawn('waiting')).rejects.toThrow(/cap reached/);

    await drainWaitingSessions();

    expect(killContainer).not.toHaveBeenCalled();
  });

  it('evicts at most one running session per saturated drain tick', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '3');
    await admitRunning('oldest');
    await admitRunning('middle');
    await admitRunning('newest');
    activeCount.value = 3;
    const now = Date.now();
    writeHeartbeat('group-1', 'oldest', now - 180_000);
    writeHeartbeat('group-1', 'middle', now - 120_000);
    writeHeartbeat('group-1', 'newest', now - 90_000);
    await expect(admitSpawn('waiting')).rejects.toThrow(/cap reached/);

    await drainWaitingSessions();

    expect(killContainer).toHaveBeenCalledTimes(1);
  });

  it('does not evict without a waiter or when capacity is available', async () => {
    vi.stubEnv('TWYN_MAX_RUNNING_AGENTS', '2');
    await admitRunning('idle');
    activeCount.value = 2;
    writeHeartbeat('group-1', 'idle', Date.now() - 120_000);
    await drainWaitingSessions();
    expect(killContainer).not.toHaveBeenCalled();

    await expect(admitSpawn('waiting')).rejects.toThrow(/cap reached/);
    activeCount.value = 1;
    await drainWaitingSessions();
    expect(killContainer).not.toHaveBeenCalled();
  });
});
