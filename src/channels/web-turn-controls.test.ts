import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = vi.hoisted(() => '/tmp/nanoclaw-web-turn-controls');
const runner = vi.hoisted(() => ({ isContainerRunning: vi.fn(() => true), killContainer: vi.fn() }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

vi.mock('../container-runner.js', () => runner);

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { inboundDbPath, outboundDbPath } from '../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../session-manager.js';
import { requestWebTurnStop, webTurnIsRunning } from './web-turn-controls.js';

const SESSION = { id: 'session-1', agent_group_id: 'agent-1' };

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  const now = new Date().toISOString();
  await createAgentGroup({
    id: SESSION.agent_group_id,
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now,
  });
  await createSession({
    ...SESSION,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: now,
  });
  initSessionFolder(SESSION.agent_group_id, SESSION.id);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('web turn running predicate', () => {
  it('stays running when a live runner has completed its initial claim', () => {
    expect(
      webTurnIsRunning({
        containerRunning: true,
        heartbeatFresh: true,
        hasWorkingStatus: true,
        hasRunnerTurn: true,
        hasClaim: false,
      }),
    ).toBe(true);
  });

  it('keeps a claimed turn stoppable before the runner publishes activity', () => {
    expect(
      webTurnIsRunning({
        containerRunning: false,
        heartbeatFresh: false,
        hasWorkingStatus: false,
        hasRunnerTurn: false,
        hasClaim: true,
      }),
    ).toBe(true);
  });

  it('becomes idle only when neither live evidence nor a claim remains', () => {
    expect(
      webTurnIsRunning({
        containerRunning: true,
        heartbeatFresh: false,
        hasWorkingStatus: false,
        hasRunnerTurn: false,
        hasClaim: false,
      }),
    ).toBe(false);
  });

  it('stays running and accepts stop through a long heartbeat and status gap', async () => {
    const sessionDir = path.join(TEST_DIR, 'v2-sessions', SESSION.agent_group_id, SESSION.id);
    const activePath = path.join(sessionDir, '.twyn-active-turn');
    fs.writeFileSync(
      activePath,
      JSON.stringify({
        inputId: 'turn-input',
        platformId: 'web:member',
        channelType: 'web',
        threadId: null,
        startedAtMs: Date.now() - 120_000,
      }),
    );
    fs.writeFileSync(path.join(sessionDir, '.heartbeat'), '');
    const longAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(sessionDir, '.heartbeat'), longAgo, longAgo);

    await expect(requestWebTurnStop(SESSION)).resolves.toMatchObject({ stopped: true });

    await expect(
      getDb().get<{ in_reply_to: string }>(
        'SELECT in_reply_to FROM web_stopped_turns WHERE session_id = ?',
        SESSION.id,
      ),
    ).resolves.toEqual({ in_reply_to: 'turn-input' });
    const inbound = new Database(inboundDbPath(SESSION.agent_group_id, SESSION.id), { readonly: true });
    const command = inbound.prepare("SELECT content FROM messages_in WHERE id LIKE 'web-stop-%'").get() as {
      content: string;
    };
    inbound.close();
    expect(JSON.parse(command.content)).toMatchObject({ type: 'twyn_stop_turn', platformId: 'web:member' });
  });

  function writeActiveTurn(inputId: string): void {
    fs.writeFileSync(
      path.join(TEST_DIR, 'v2-sessions', SESSION.agent_group_id, SESSION.id, '.twyn-active-turn'),
      JSON.stringify({
        inputId,
        platformId: 'web:member',
        channelType: 'web',
        threadId: null,
        startedAtMs: Date.now() - 5_000,
      }),
    );
  }

  it('kills the container when the stopped turn is still active after the grace period', async () => {
    writeActiveTurn('stuck-turn');

    await expect(requestWebTurnStop(SESSION, { graceMs: 20 })).resolves.toMatchObject({ stopped: true });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(runner.killContainer).toHaveBeenCalledWith(SESSION.id, 'web-stop-grace', expect.any(Function));
  });

  it('never kills the next turn once the stopped turn has wound down', async () => {
    writeActiveTurn('stopped-turn');

    await expect(requestWebTurnStop(SESSION, { graceMs: 20 })).resolves.toMatchObject({ stopped: true });
    writeActiveTurn('next-turn');
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(runner.killContainer).not.toHaveBeenCalled();
  });

  it('writes one stop command when two tabs stop the same live turn', async () => {
    writeActiveTurn('shared-turn');

    await expect(requestWebTurnStop(SESSION, { graceMs: 60_000 })).resolves.toMatchObject({ stopped: true });
    await expect(requestWebTurnStop(SESSION, { graceMs: 60_000 })).resolves.toEqual({ stopped: true });

    const inbound = new Database(inboundDbPath(SESSION.agent_group_id, SESSION.id), { readonly: true });
    const commands = inbound.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE id LIKE 'web-stop-%'").get() as {
      n: number;
    };
    inbound.close();
    expect(commands.n).toBe(1);
  });

  it('sends a fresh stop when the turn outlives the grace window and Stop is pressed again', async () => {
    writeActiveTurn('stubborn-turn');

    await expect(requestWebTurnStop(SESSION, { graceMs: 20 })).resolves.toMatchObject({ stopped: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(requestWebTurnStop(SESSION, { graceMs: 20 })).resolves.toMatchObject({ stopped: true });

    const inbound = new Database(inboundDbPath(SESSION.agent_group_id, SESSION.id), { readonly: true });
    const commands = inbound.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE id LIKE 'web-stop-%'").get() as {
      n: number;
    };
    inbound.close();
    expect(commands.n).toBe(2);
  });

  it('writes one stopped notice when two tabs stop the same cold-start input', async () => {
    const inbound = new Database(inboundDbPath(SESSION.agent_group_id, SESSION.id));
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('cold-shared', 2, 'chat', ?, 'pending', 1, 'web:member', 'web', NULL, ?)`,
      )
      .run(new Date().toISOString(), JSON.stringify({ text: 'hello', sender: 'web', senderId: 'web:member' }));
    inbound.close();

    await expect(requestWebTurnStop(SESSION, { graceMs: 60_000 })).resolves.toMatchObject({ stopped: true });
    await expect(requestWebTurnStop(SESSION, { graceMs: 60_000 })).resolves.toEqual({ stopped: true });

    const outbound = new Database(outboundDbPath(SESSION.agent_group_id, SESSION.id), { readonly: true });
    const notices = outbound.prepare("SELECT COUNT(*) AS n FROM messages_out WHERE id LIKE 'web-stopped-%'").get() as {
      n: number;
    };
    outbound.close();
    expect(notices.n).toBe(1);
  });

  it('does not trust a runner marker beyond the reconciliation ceiling', async () => {
    const activePath = path.join(TEST_DIR, 'v2-sessions', SESSION.agent_group_id, SESSION.id, '.twyn-active-turn');
    fs.writeFileSync(
      activePath,
      JSON.stringify({
        inputId: 'expired-turn',
        platformId: 'web:member',
        channelType: 'web',
        threadId: null,
        startedAtMs: Date.now() - 31 * 60 * 1000,
      }),
    );

    await expect(requestWebTurnStop(SESSION)).resolves.toEqual({ stopped: false });
  });

  it('cancels an unclaimed cold-start input and writes its stopped notice', async () => {
    const inbound = new Database(inboundDbPath(SESSION.agent_group_id, SESSION.id));
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, 2, 'chat', ?, 'pending', 1, ?, 'web', NULL, ?)`,
      )
      .run(
        'cold-input',
        new Date().toISOString(),
        'web:member',
        JSON.stringify({ text: 'sleep 90', sender: 'web', senderId: 'web:member' }),
      );
    inbound.close();

    await expect(requestWebTurnStop(SESSION)).resolves.toMatchObject({ stopped: true });

    await expect(
      getDb().get<{ in_reply_to: string }>(
        'SELECT in_reply_to FROM web_stopped_turns WHERE session_id = ?',
        SESSION.id,
      ),
    ).resolves.toEqual({ in_reply_to: 'cold-input' });
    const outbound = new Database(outboundDbPath(SESSION.agent_group_id, SESSION.id), { readonly: true });
    const notice = outbound.prepare("SELECT content FROM messages_out WHERE id LIKE 'web-stopped-%'").get() as {
      content: string;
    };
    outbound.close();
    expect(JSON.parse(notice.content)).toEqual({ type: 'twyn_turn_stopped', text: 'Stopped' });

    const commandDb = new Database(inboundDbPath(SESSION.agent_group_id, SESSION.id), { readonly: true });
    const command = commandDb.prepare("SELECT content FROM messages_in WHERE id LIKE 'web-stop-%'").get() as {
      content: string;
    };
    commandDb.close();
    expect(JSON.parse(command.content)).toMatchObject({
      type: 'twyn_stop_turn',
      cancelInputIds: ['cold-input'],
      noticeAlreadyWritten: true,
    });
  });
});
