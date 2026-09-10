import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const message of sdkMessages) yield message;
    })(),
}));

const { ClaudeProvider } = await import('./providers/claude.js');
const { MEMORY_SESSION_HOOK } = await import('./memory/session-hook.js');
const { statusFilePath } = await import('./twyn-status.js');

let tmp: string;
let previousHeartbeatPath: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twyn-status-claude-'));
  previousHeartbeatPath = process.env.NANOCLAW_HEARTBEAT_PATH;
  previousHome = process.env.HOME;
  process.env.NANOCLAW_HEARTBEAT_PATH = path.join(tmp, '.heartbeat');
  process.env.HOME = tmp;
});

afterEach(() => {
  if (previousHeartbeatPath === undefined) delete process.env.NANOCLAW_HEARTBEAT_PATH;
  else process.env.NANOCLAW_HEARTBEAT_PATH = previousHeartbeatPath;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Claude compact-boundary status', () => {
  it('publishes Tidying memory before the compact boundary is translated', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 132642 } },
      { type: 'result', subtype: 'success', result: '<message to="user">hello</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const events = provider.query({ prompt: 'hi', cwd: tmp }).events;
    let sawCompactionStatus = false;
    for await (const _event of events) {
      if (fs.existsSync(statusFilePath())) {
        expect(fs.readFileSync(statusFilePath(), 'utf8')).toBe('Tidying memory (133k tokens)\n');
        sawCompactionStatus = true;
      }
    }

    expect(sawCompactionStatus).toBe(true);
    expect(fs.existsSync(statusFilePath())).toBe(false);
  });
});
