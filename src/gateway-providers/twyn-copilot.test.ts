import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateSpec, type SessionSpec } from '../drivers/types.js';
import { getGatewayProvider, resetGatewayProvider } from './index.js';

afterEach(() => {
  resetGatewayProvider();
  vi.unstubAllEnvs();
});

describe('twyn-copilot gateway provider', () => {
  it('is selected by NANOCLAW_GATEWAY_PROVIDER and contributes only the gateway endpoint and dummy token', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', 'twyn-copilot');

    const contribution = await getGatewayProvider().contribute({
      key: { installSlug: 'test', agentGroupId: 'group-1', sessionId: 'session-1' },
      groupName: 'Spike',
      capabilities: {
        isolationTiers: ['container'],
        admissionEnforced: false,
        networkPolicy: 'topology',
        encryptedVolumes: false,
        unrealized: [],
        sharedNetworkNamespace: false,
        auxiliaryContainers: false,
        imageBuild: true,
      },
    });

    expect(getGatewayProvider().kind).toBe('twyn-copilot');
    expect(contribution.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://copilot-gateway:4141',
      ANTHROPIC_AUTH_TOKEN: 'sk-dummy',
    });

    const spec: SessionSpec = {
      key: { installSlug: 'test', agentGroupId: 'group-1', sessionId: 'session-1' },
      labels: {},
      containers: [
        {
          role: 'agent',
          image: 'test-image',
          env: {},
          contributedEnv: contribution.env,
          mounts: [],
        },
      ],
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
});
