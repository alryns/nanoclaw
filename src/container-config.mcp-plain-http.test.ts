import { describe, expect, it, vi } from 'vitest';

// TwynOracle: NANOCLAW_MCP_PLAIN_HTTP_HOSTS extends plain-HTTP MCP URLs to named internal
// services. Upstream's loopback-only rule must be unchanged when the knob is empty.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, MCP_PLAIN_HTTP_HOSTS: ['mcp-knowledge'] };
});

import { parseMcpServerConfig } from './container-config.js';

describe('MCP plain-HTTP host allowlist', () => {
  it('accepts an allowlisted internal service over plain http', () => {
    const cfg = parseMcpServerConfig({ url: 'http://mcp-knowledge:8092/mcp' });
    expect(cfg.type).toBe('http');
  });
  it('still refuses plain http to a host that is neither loopback nor allowlisted', () => {
    expect(() => parseMcpServerConfig({ url: 'http://example.com/mcp' })).toThrow(/must use HTTPS/);
  });
  it('keeps upstream loopback allowances', () => {
    expect(parseMcpServerConfig({ url: 'http://localhost:1/mcp' }).type).toBe('http');
    expect(parseMcpServerConfig({ url: 'http://host.docker.internal:1/mcp' }).type).toBe('http');
  });
});
