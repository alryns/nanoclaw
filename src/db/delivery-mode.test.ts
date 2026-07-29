/**
 * The per-group delivery contract, host side.
 *
 * Two guarantees the container depends on:
 *   1. The column is nullable with no default, so every pre-existing row keeps
 *      resolving to the envelope contract.
 *   2. A value only reaches `container.json` when it is one the runner knows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getDb, initTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './container-configs.js';
import { configFromDb } from '../container-config.js';
import type { AgentGroup, ContainerConfigRow } from '../types.js';

const GROUP: AgentGroup = {
  id: 'ag-1',
  name: 'Casa',
  folder: 'casa',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function baseRow(deliveryMode: string | null): ContainerConfigRow {
  return {
    agent_group_id: GROUP.id,
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    delivery_mode: deliveryMode,
    updated_at: GROUP.created_at,
  };
}

describe('container_configs.delivery_mode', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ ...GROUP });
  });
  afterEach(() => {
    closeDb();
  });

  it('is a nullable, default-free column — a fresh row inherits the envelope contract (020)', () => {
    ensureContainerConfig(GROUP.id);

    const columns = getDb().prepare('PRAGMA table_info(container_configs)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const column = columns.find((c) => c.name === 'delivery_mode');

    expect(column).toBeDefined();
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();
    expect(getContainerConfig(GROUP.id)?.delivery_mode).toBeNull();
  });

  it('is settable through the scalar allowlist', () => {
    ensureContainerConfig(GROUP.id);

    updateContainerConfigScalars(GROUP.id, { delivery_mode: 'tools-only' });
    expect(getContainerConfig(GROUP.id)?.delivery_mode).toBe('tools-only');

    updateContainerConfigScalars(GROUP.id, { delivery_mode: 'envelope' });
    expect(getContainerConfig(GROUP.id)?.delivery_mode).toBe('envelope');
  });

  it('still rejects columns outside the allowlist', () => {
    ensureContainerConfig(GROUP.id);

    expect(() => updateContainerConfigScalars(GROUP.id, { delivery_modes: 'tools-only' } as never)).toThrow(
      /Invalid scalar column/,
    );
  });

  it('carries a known mode into container.json and drops anything else', () => {
    expect(configFromDb(baseRow('tools-only'), GROUP).deliveryMode).toBe('tools-only');
    expect(configFromDb(baseRow('envelope'), GROUP).deliveryMode).toBe('envelope');
    // NULL and unrecognized values both leave the runner on its default.
    expect(configFromDb(baseRow(null), GROUP).deliveryMode).toBeUndefined();
    expect(configFromDb(baseRow('tools_only'), GROUP).deliveryMode).toBeUndefined();
  });
});
