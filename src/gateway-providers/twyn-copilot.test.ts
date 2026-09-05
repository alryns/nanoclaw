import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports; vi.hoisted runs first so the factory can see the dir.
const { groupsDir } = vi.hoisted(() => {
  return { groupsDir: `/tmp/twyn-groups-${process.pid}-${Date.now()}` };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, GROUPS_DIR: groupsDir };
});
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => (id === 'group-1' ? { id, name: 'Spike', folder: 'spike' } : undefined)),
}));

import { validateSpec, type SessionSpec } from '../drivers/types.js';
import { getGatewayProvider, resetGatewayProvider } from './index.js';
import { TWYN_ENV_FILE } from './twyn-copilot.js';
import { _resetTwynLifecycleForTesting } from './twyn-lifecycle.js';

const input = {
  key: { installSlug: 'test', agentGroupId: 'group-1', sessionId: 'session-1' },
  groupName: 'Spike',
  capabilities: {
    isolationTiers: ['container' as const],
    admissionEnforced: false,
    networkPolicy: 'topology' as const,
    encryptedVolumes: false,
    unrealized: [],
    sharedNetworkNamespace: false,
    auxiliaryContainers: false,
    imageBuild: true,
  },
};
const envFile = path.join(groupsDir, 'spike', TWYN_ENV_FILE);

beforeEach(() => {
  _resetTwynLifecycleForTesting();
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', 'twyn-copilot');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.rmSync(envFile, { force: true });
});
afterEach(() => {
  _resetTwynLifecycleForTesting();
  resetGatewayProvider();
  vi.unstubAllEnvs();
});

describe('twyn-copilot gateway provider', () => {
  it('is selected by NANOCLAW_GATEWAY_PROVIDER and contributes the gateway endpoint and dummy token', async () => {
    const contribution = await getGatewayProvider().contribute(input);
    expect(getGatewayProvider().kind).toBe('twyn-copilot');
    expect(contribution.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://copilot-gateway:4141',
      ANTHROPIC_AUTH_TOKEN: 'sk-dummy',
    });

    const spec: SessionSpec = {
      key: input.key,
      labels: {},
      containers: [{ role: 'agent', image: 'test-image', env: {}, contributedEnv: contribution.env, mounts: [] }],
      network: 'none',
      hardening: 'standard',
      resources: {},
      runtimeTier: 'container',
      stopGraceSeconds: 1,
    };
    expect(() =>
      validateSpec(spec, {
        groupsRoot: '/groups',
        dataRoot: '/data',
        surfaceRoots: ['/surface'],
        materialsRoot: '/materials',
      }),
    ).not.toThrow();
  });

  it('merges the provisioner-written twyn-env.json for the group', async () => {
    fs.writeFileSync(
      envFile,
      JSON.stringify({ TWYNBRAIN_READONLY: '1', TWYNBRAIN_GATE_RECORD: '/workspace/twyn/gate-record.md' }),
    );
    const { env } = await getGatewayProvider().contribute(input);
    expect(env).toMatchObject({ TWYNBRAIN_READONLY: '1', TWYNBRAIN_GATE_RECORD: '/workspace/twyn/gate-record.md' });
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-dummy');
  });

  it('contributes only the base env for a group without the file or without a DB row', async () => {
    const { env } = await getGatewayProvider().contribute(input);
    expect(Object.keys(env ?? {}).sort()).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
    const other = await getGatewayProvider().contribute({
      ...input,
      key: { ...input.key, agentGroupId: 'missing', sessionId: 'session-2' },
    });
    expect(Object.keys(other.env ?? {}).length).toBe(2);
  });

  it('fails closed on malformed JSON, non-string values, bad names and reserved keys', async () => {
    fs.writeFileSync(envFile, '{ not json');
    await expect(getGatewayProvider().contribute(input)).rejects.toThrow(/not valid JSON/);
    fs.writeFileSync(envFile, JSON.stringify({ TWYNBRAIN_READONLY: 1 }));
    await expect(
      getGatewayProvider().contribute({ ...input, key: { ...input.key, sessionId: 'session-2' } }),
    ).rejects.toThrow(/must be a string/);
    fs.writeFileSync(envFile, JSON.stringify({ 'lower-case': 'x' }));
    await expect(
      getGatewayProvider().contribute({ ...input, key: { ...input.key, sessionId: 'session-3' } }),
    ).rejects.toThrow(/not an environment variable name/);
    fs.writeFileSync(envFile, JSON.stringify({ ANTHROPIC_BASE_URL: 'http://evil' }));
    await expect(
      getGatewayProvider().contribute({ ...input, key: { ...input.key, sessionId: 'session-4' } }),
    ).rejects.toThrow(/reserved/);
  });

  it('refuses credential-shaped values so secrets never ride the env', async () => {
    fs.writeFileSync(envFile, JSON.stringify({ TWYN_COOKIE: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' }));
    await expect(getGatewayProvider().contribute(input)).rejects.toThrow(/looks like a credential/);
  });
});
