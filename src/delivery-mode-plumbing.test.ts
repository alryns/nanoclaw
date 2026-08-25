/**
 * Delivery mode, host side: the path from the column to the file the container
 * reads, the CLI surface that sets it, and the boundary that stops an agent
 * from setting it for itself.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The factory is hoisted above every binding in this file, so the path is
// spelled out inline rather than built from the constant below.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-delivery-mode/groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-mode';

import { initTestDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { materializeContainerJson, type ContainerConfig } from './container-config.js';
import { commandGuardSpec } from './cli/guard.js';
import { lookup } from './cli/registry.js';
// Side-effect import: registers the `groups-*` commands.
import './cli/resources/groups.js';

const GID = 'ag-1';

async function seedGroup(): Promise<void> {
  await createAgentGroup({
    id: GID,
    name: 'Casa',
    folder: 'casa',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(GID);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups', 'casa'), { recursive: true });
  const db = initTestDb();
  await runMigrations(await db);
  await seedGroup();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function readContainerJson(): ContainerConfig {
  return JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'groups', 'casa', 'container.json'), 'utf8'));
}

describe('column reaches the container', () => {
  it('omits deliveryMode entirely for a default group', async () => {
    await materializeContainerJson(GID);

    expect(readContainerJson().deliveryMode).toBeUndefined();
  });

  it('writes deliveryMode into container.json once the column is set', async () => {
    await updateContainerConfigScalars(GID, { delivery_mode: 'tools-only' });

    const returned = await materializeContainerJson(GID);

    expect(returned.deliveryMode).toBe('tools-only');
    expect(readContainerJson().deliveryMode).toBe('tools-only');
  });

  it('drops a value the runner would not recognize rather than passing it through', async () => {
    await updateContainerConfigScalars(GID, { delivery_mode: 'tools_only' });

    await materializeContainerJson(GID);

    expect(readContainerJson().deliveryMode).toBeUndefined();
  });
});

describe('groups config update --delivery-mode', () => {
  const handler = () => lookup('groups-config-update')!.handler;

  it('sets the column and echoes it back', async () => {
    const result = (await handler()({ id: GID, 'delivery-mode': 'tools-only' }, {
      caller: 'host',
    } as never)) as Record<string, unknown>;

    expect((await getContainerConfig(GID))?.delivery_mode).toBe('tools-only');
    expect(result.delivery_mode).toBe('tools-only');
  });

  it('accepts the underscore spelling too', async () => {
    await handler()({ id: GID, delivery_mode: 'envelope' }, { caller: 'host' } as never);

    expect((await getContainerConfig(GID))?.delivery_mode).toBe('envelope');
  });

  it('rejects anything else and leaves the column alone', async () => {
    await expect(handler()({ id: GID, 'delivery-mode': 'yolo' }, { caller: 'host' } as never)).rejects.toThrow(
      /--delivery-mode must be one of: envelope, tools-only/,
    );
    expect((await getContainerConfig(GID))?.delivery_mode).toBeNull();
  });

  it('still refuses a call that names no field at all', async () => {
    await expect(handler()({ id: GID }, { caller: 'host' } as never)).rejects.toThrow(/Nothing to update/);
  });
});

describe('an agent cannot widen its own containment', () => {
  const spec = () => commandGuardSpec(lookup('groups-config-update')!);
  const actor = { kind: 'agent', agentGroupId: GID, sessionId: 's1' } as const;

  it('denies delivery_mode outright from a group-scoped agent — not merely holds it', async () => {
    for (const key of ['delivery_mode', 'delivery-mode']) {
      const decision = await spec().decide({ actor, payload: { id: GID, [key]: 'envelope' } });

      expect(decision.effect).toBe('deny');
      expect(decision.reason).toContain('delivery_mode');
    }
  });

  it('denies it even when the value would keep the group where it is', async () => {
    const decision = await spec().decide({ actor, payload: { id: GID, delivery_mode: 'tools-only' } });

    expect(decision.effect).toBe('deny');
  });

  it('still only holds an ordinary config change from the same agent', async () => {
    const decision = await spec().decide({ actor, payload: { id: GID, model: 'some-model' } });

    expect(decision.effect).toBe('hold');
  });

  it('leaves the host caller alone', async () => {
    const decision = await spec().decide({
      actor: { kind: 'host' },
      payload: { id: GID, delivery_mode: 'tools-only' },
    });

    expect(decision.effect).toBe('allow');
  });
});
