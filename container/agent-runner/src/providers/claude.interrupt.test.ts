import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const interrupt = mock(async () => undefined);

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const events = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'stop-test' };
    })();
    return Object.assign(events, { interrupt });
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  interrupt.mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interrupt-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider interruption', () => {
  it('calls the SDK interrupt API as well as closing the prompt stream', () => {
    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({ prompt: 'stop now', cwd: tmp });

    query.abort();

    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
