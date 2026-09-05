/** Web channel adapter tests: PocketBase auth, transcript streaming, and SSE delivery. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from './adapter.js';
import type { HistoryRow } from '../modules/cross-session-context/index.js';

const transcript = vi.hoisted(() => ({
  findSessionByAgentGroup: vi.fn(),
  getMessagingGroupAgents: vi.fn(),
  getMessagingGroupByPlatform: vi.fn(),
  readOutboxFiles: vi.fn(),
  sessionHistory: vi.fn(),
}));
const WEB_FILES_TEST_DATA_DIR = vi.hoisted(() => '/tmp/nanoclaw-web-files-test');

// A fixed test port keeps the actual browser-facing HTTP path under test while
// leaving the running install's configured listener untouched.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: WEB_FILES_TEST_DATA_DIR, TWYN_WEB_PORT: 18091 };
});

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupAgents: transcript.getMessagingGroupAgents,
  getMessagingGroupByPlatform: transcript.getMessagingGroupByPlatform,
}));

vi.mock('../db/sessions.js', () => ({ findSessionByAgentGroup: transcript.findSessionByAgentGroup }));

vi.mock('../session-manager.js', () => ({ readOutboxFiles: transcript.readOutboxFiles }));

vi.mock('../modules/cross-session-context/index.js', () => ({
  HISTORY_DEFAULT_LIMIT: 50,
  sessionHistory: transcript.sessionHistory,
}));

import { createWebAdapter } from './web.js';

const nativeFetch = globalThis.fetch;
const fetchMock = vi.fn();

let adapter: ReturnType<typeof createWebAdapter>;
let inbound: InboundEvent[];
let historyRows: HistoryRow[];

interface OpenStream {
  close(): Promise<void>;
  next(): Promise<HistoryRow & { backfill: boolean }>;
}

function eventFromInbound(platformId: string, threadId: string | null, message: InboundEvent['message']): InboundEvent {
  return { channelType: 'web', platformId, threadId, message };
}

function messageUrl(): string {
  return 'http://127.0.0.1:18091/web/message';
}

function streamUrl(): string {
  return 'http://127.0.0.1:18091/web/stream';
}

function historyUrl(query = ''): string {
  return `http://127.0.0.1:18091/web/history${query}`;
}

function fileUrl(query = ''): string {
  return `http://127.0.0.1:18091/web/file${query}`;
}

function vaultUrl(query = ''): string {
  return `http://127.0.0.1:18091/web/vault${query}`;
}

function row(
  text: string,
  timestamp: string,
  direction: HistoryRow['direction'] = 'out',
  sender = direction === 'out' ? 'Agent' : 'Slack user',
): HistoryRow {
  return { timestamp, direction, kind: 'chat', sender, text };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openStream(token = 'stream-token'): Promise<OpenStream> {
  const response = await nativeFetch(streamUrl(), { headers: { Authorization: `Bearer ${token}` } });
  const reader = response.body?.getReader();
  expect(response.status).toBe(200);
  expect(reader).toBeDefined();

  let buffer = '';
  return {
    async close(): Promise<void> {
      await reader!.cancel();
    },
    async next(): Promise<HistoryRow & { backfill: boolean }> {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (event.startsWith(':')) continue;
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trimStart())
            .join('\n');
          return JSON.parse(data) as HistoryRow & { backfill: boolean };
        }
        const chunk = await reader!.read();
        if (chunk.done) throw new Error('SSE stream ended before the next event');
        buffer += new TextDecoder().decode(chunk.value);
      }
    },
  };
}

async function waitForInitialTranscriptRead(): Promise<void> {
  await vi.waitFor(() => expect(transcript.sessionHistory).toHaveBeenCalled(), { timeout: 500 });
}

beforeEach(async () => {
  fs.rmSync(WEB_FILES_TEST_DATA_DIR, { recursive: true, force: true });
  inbound = [];
  historyRows = [];
  fetchMock.mockReset();
  // A fresh Response per call: a Body can be read once, and real fetch never reuses one.
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ record: { id: 'user-123' } }), { status: 200 }),
  );
  transcript.getMessagingGroupByPlatform.mockReset();
  transcript.getMessagingGroupAgents.mockReset();
  transcript.findSessionByAgentGroup.mockReset();
  transcript.readOutboxFiles.mockReset();
  transcript.sessionHistory.mockReset();
  transcript.getMessagingGroupByPlatform.mockResolvedValue({ id: 'web-messaging-group' });
  transcript.getMessagingGroupAgents.mockResolvedValue([{ agent_group_id: 'agent-group' }]);
  transcript.findSessionByAgentGroup.mockResolvedValue({ id: 'shared-session', agent_group_id: 'agent-group' });
  transcript.sessionHistory.mockImplementation(async () => historyRows);
  vi.stubGlobal('fetch', fetchMock);
  adapter = createWebAdapter({ pollIntervalMs: 20, tokenCacheMax: 2 });
  await adapter.setup({
    onInbound(platformId, threadId, message) {
      inbound.push(
        eventFromInbound(platformId, threadId, {
          ...message,
          content: JSON.stringify(message.content),
        }),
      );
    },
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  });
});

afterEach(async () => {
  await adapter.teardown();
  vi.unstubAllEnvs();
  fs.rmSync(WEB_FILES_TEST_DATA_DIR, { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('web channel', () => {
  it('returns 401 when history has no token', async () => {
    const response = await nativeFetch(historyUrl());

    expect(response.status).toBe(401);
  });

  it('rejects non-GET history requests', async () => {
    const response = await nativeFetch(historyUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer history-token' },
    });

    expect(response.status).toBe(405);
  });

  it('keeps file metadata in the history response', async () => {
    historyRows = [
      { ...row('download ready', '2026-09-04T10:00:00.000Z'), messageId: 'out-files', files: ['report.html'] },
    ];

    const response = await nativeFetch(historyUrl(), { headers: { Authorization: 'Bearer history-files-token' } });

    await expect(response.json()).resolves.toEqual({ rows: historyRows, exhausted: true });
  });

  it('returns 401 when a file has no token', async () => {
    const response = await nativeFetch(fileUrl('?message=out-files&name=report.html'));

    expect(response.status).toBe(401);
  });

  it('rejects an unsafe file name', async () => {
    const response = await nativeFetch(fileUrl('?message=out-files&name=..%2Fsecret.html'), {
      headers: { Authorization: 'Bearer file-bad-name-token' },
    });

    expect(response.status).toBe(400);
  });

  it.each([fileUrl('?message=out-files&name=report.html'), vaultUrl('?path=guide.md')])(
    'rejects non-GET requests to %s',
    async (url) => {
      const response = await nativeFetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer route-method-token' },
      });

      expect(response.status).toBe(405);
    },
  );

  it('returns 404 when an outbox file is absent', async () => {
    const response = await nativeFetch(fileUrl('?message=out-files&name=report.html'), {
      headers: { Authorization: 'Bearer file-missing-token' },
    });

    expect(response.status).toBe(404);
    expect(transcript.readOutboxFiles).toHaveBeenCalledWith('agent-group', 'shared-session', 'out-files', [
      'report.html',
    ]);
  });

  it('serves an html outbox file with the restrictive headers', async () => {
    transcript.readOutboxFiles.mockReturnValue([{ filename: 'report.html', data: Buffer.from('<h1>Report</h1>') }]);

    const response = await nativeFetch(fileUrl('?message=out-files&name=report.html'), {
      headers: { Authorization: 'Bearer file-html-token' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="report.html"');
    await expect(response.text()).resolves.toBe('<h1>Report</h1>');
  });

  it('retains delivered files and serves the retained html copy after outbox cleanup', async () => {
    historyRows = [
      { ...row('download ready', '2026-09-04T10:00:00.000Z'), messageId: 'msg-web-files', files: ['hello.html'] },
    ];
    await adapter.deliver('web:user-123', null, {
      kind: 'chat',
      content: { text: 'download ready', files: ['hello.html'] },
      files: [{ filename: 'hello.html', data: Buffer.from('<h1>Hello</h1>') }],
    });
    expect(
      fs.readFileSync(
        path.join(WEB_FILES_TEST_DATA_DIR, 'web-files', 'agent-group', 'shared-session', 'msg-web-files', 'hello.html'),
        'utf8',
      ),
    ).toBe('<h1>Hello</h1>');
    transcript.readOutboxFiles.mockReturnValue(undefined);

    const response = await nativeFetch(fileUrl('?message=msg-web-files&name=hello.html'), {
      headers: { Authorization: 'Bearer retained-file-token' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    await expect(response.text()).resolves.toBe('<h1>Hello</h1>');
    expect(transcript.readOutboxFiles).not.toHaveBeenCalled();
  });

  it('retains a second file for the same session after the group and session directories exist', async () => {
    const stored = (messageId: string, name: string) =>
      path.join(WEB_FILES_TEST_DATA_DIR, 'web-files', 'agent-group', 'shared-session', messageId, name);
    await adapter.deliver('web:user-123', null, {
      kind: 'chat',
      content: { id: 'msg-first-file', text: 'first', files: ['first.svg'] },
      files: [{ filename: 'first.svg', data: Buffer.from('<svg/>') }],
    });
    await adapter.deliver('web:user-123', null, {
      kind: 'chat',
      content: { id: 'msg-second-file', text: 'second', files: ['second.svg'] },
      files: [{ filename: 'second.svg', data: Buffer.from('<svg><g/></svg>') }],
    });

    expect(fs.readFileSync(stored('msg-first-file', 'first.svg'), 'utf8')).toBe('<svg/>');
    expect(fs.readFileSync(stored('msg-second-file', 'second.svg'), 'utf8')).toBe('<svg><g/></svg>');
  });

  it('refuses to retain a file whose name has a path separator', async () => {
    await adapter.deliver('web:user-123', null, {
      kind: 'chat',
      content: { id: 'msg-unsafe-file', text: 'unsafe' },
      files: [{ filename: 'nested/hello.html', data: Buffer.from('unsafe') }],
    });

    expect(
      fs.existsSync(
        path.join(
          WEB_FILES_TEST_DATA_DIR,
          'web-files',
          'agent-group',
          'shared-session',
          'msg-unsafe-file',
          'nested',
          'hello.html',
        ),
      ),
    ).toBe(false);
  });

  it('returns 401 when a vault page has no token', async () => {
    const response = await nativeFetch(vaultUrl('?path=guide.md'));

    expect(response.status).toBe(401);
  });

  it('rejects vault traversal and non-markdown paths', async () => {
    for (const requestPath of ['..%2Fguide.md', 'guide.txt']) {
      // Connection: close, so the second request's socket is not pooled past this test's
      // server (the next test starts a fresh server on the same port).
      const response = await nativeFetch(vaultUrl(`?path=${requestPath}`), {
        headers: { Authorization: 'Bearer vault-invalid-token', Connection: 'close' },
      });
      expect(response.status).toBe(400);
    }
  });

  // One request per test: the fixture server is recreated per test on a fixed port and a second
  // sequential fetch can reuse a pooled socket from the previous server.
  function vaultFixtureWithOutsideLink(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-web-vault-'));
    const docsRoot = path.join(root, 'current', 'vaults', 'docs');
    const outside = path.join(root, 'outside.md');
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(docsRoot, 'outside.md'));
    vi.stubEnv('TWYN_BUNDLE_ROOT', root);
    return root;
  }

  it('resolves a bare slug to the unique page under the docs root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-web-vault-'));
    const docsRoot = path.join(root, 'current', 'vaults', 'docs', 'wiki', 'sources');
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(docsRoot, '2026-08-29-notes.md'), '# Notes\n');
    vi.stubEnv('TWYN_BUNDLE_ROOT', root);
    const response = await nativeFetch(vaultUrl('?slug=2026-08-29-notes'), {
      headers: { Authorization: 'Bearer vault-slug-token', Connection: 'close' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# Notes\n');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns 404 for an unknown slug and 400 for a slug with a slash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-web-vault-'));
    fs.mkdirSync(path.join(root, 'current', 'vaults', 'docs'), { recursive: true });
    vi.stubEnv('TWYN_BUNDLE_ROOT', root);
    const missing = await nativeFetch(vaultUrl('?slug=nope'), {
      headers: { Authorization: 'Bearer vault-slug-token', Connection: 'close' },
    });
    expect(missing.status).toBe(404);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns 404 for a missing vault page', async () => {
    const root = vaultFixtureWithOutsideLink();
    const response = await nativeFetch(vaultUrl('?path=missing.md'), {
      headers: { Authorization: 'Bearer vault-missing-token' },
    });
    expect(response.status).toBe(404);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns 404 for a vault page whose symlink leaves the docs root', async () => {
    const root = vaultFixtureWithOutsideLink();
    const response = await nativeFetch(vaultUrl('?path=outside.md'), {
      headers: { Authorization: 'Bearer vault-missing-token' },
    });
    expect(response.status).toBe(404);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves a markdown vault page within the configured docs root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-web-vault-'));
    const docsRoot = path.join(root, 'current', 'vaults', 'docs', 'nested');
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(docsRoot, 'guide.md'), '# Guide\n');
    vi.stubEnv('TWYN_BUNDLE_ROOT', root);

    const response = await nativeFetch(vaultUrl('?path=nested/guide.md'), {
      headers: { Authorization: 'Bearer vault-page-token' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.text()).resolves.toBe('# Guide\n');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the newest history page oldest-first and reports more rows', async () => {
    historyRows = [
      row('one', '2026-09-04T10:00:00.000Z'),
      row('two', '2026-09-04T10:01:00.000Z'),
      row('three', '2026-09-04T10:02:00.000Z'),
    ];
    transcript.sessionHistory.mockImplementation(async (args) => historyRows.slice(-Number(args.limit)));

    const response = await nativeFetch(historyUrl('?limit=2'), { headers: { Authorization: 'Bearer history-token' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ rows: historyRows.slice(1), exhausted: false });
  });

  it('reports exhausted at the start of history', async () => {
    historyRows = [row('first', '2026-09-04T10:00:00.000Z')];

    const response = await nativeFetch(historyUrl('?before=2026-09-04T10:00:00.000Z'), {
      headers: { Authorization: 'Bearer history-token' },
    });

    await expect(response.json()).resolves.toEqual({ rows: historyRows, exhausted: true });
  });

  it('uses before to exclude newer rows', async () => {
    historyRows = [
      row('one', '2026-09-04T10:00:00.000Z'),
      row('two', '2026-09-04T10:01:00.000Z'),
      row('three', '2026-09-04T10:02:00.000Z'),
    ];
    transcript.sessionHistory.mockImplementation(async (args) =>
      historyRows.filter((entry) => entry.timestamp <= String(args.before)).slice(-Number(args.limit)),
    );

    const response = await nativeFetch(historyUrl('?before=2026-09-04T10:01:00.000Z'), {
      headers: { Authorization: 'Bearer history-token' },
    });

    await expect(response.json()).resolves.toEqual({ rows: historyRows.slice(0, 2), exhausted: true });
  });

  it('caps history limit at 200', async () => {
    const response = await nativeFetch(historyUrl('?limit=999'), {
      headers: { Authorization: 'Bearer history-token' },
    });

    expect(response.status).toBe(200);
    expect(transcript.sessionHistory).toHaveBeenLastCalledWith(
      { id: 'shared-session', limit: 201 },
      { caller: 'host' },
    );
  });

  it('uses the newest rows when before is missing', async () => {
    historyRows = [
      row('one', '2026-09-04T10:00:00.000Z'),
      row('two', '2026-09-04T10:01:00.000Z'),
      row('three', '2026-09-04T10:02:00.000Z'),
    ];
    transcript.sessionHistory.mockImplementation(async (args) => historyRows.slice(-Number(args.limit)));

    const response = await nativeFetch(historyUrl('?limit=2'), { headers: { Authorization: 'Bearer history-token' } });

    await expect(response.json()).resolves.toEqual({ rows: historyRows.slice(1), exhausted: false });
  });

  it('returns 401 when a message has no token', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });

    expect(response.status).toBe(401);
    expect(inbound).toEqual([]);
  });

  it('returns 401 when PocketBase rejects the token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }));

    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer rejected-token' },
      body: JSON.stringify({ text: 'hello' }),
    });

    expect(response.status).toBe(401);
    expect(inbound).toEqual([]);
  });

  it('verifies the token with a POST to auth-refresh (a GET would hit the SPA fallback)', async () => {
    await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: JSON.stringify({ text: 'x' }),
    });
    const call = fetchMock.mock.calls.find(([url]) => /\/api\/collections\/users\/auth-refresh$/.test(String(url)));
    expect(call).toBeDefined();
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('turns a valid authenticated message into one web InboundEvent', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ text: 'hello agent' }),
    });

    expect(response.status).toBe(202);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      channelType: 'web',
      platformId: 'web:user-123',
      threadId: null,
      message: {
        kind: 'chat',
        content: JSON.stringify({ text: 'hello agent', sender: 'web', senderId: 'web:user-123' }),
      },
    });
  });

  it('leaves text unchanged when tool and mode use their defaults', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer defaults-token' },
      body: JSON.stringify({ text: 'hello agent' }),
    });

    expect(response.status).toBe(202);
    expect(inbound[0]?.message.content).toBe(
      JSON.stringify({ text: 'hello agent', sender: 'web', senderId: 'web:user-123' }),
    );
  });

  it('prefixes a tool-only selection on its own first line', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer tool-token' },
      body: JSON.stringify({ text: 'find this', tool: 'twyn-query' }),
    });

    expect(response.status).toBe(202);
    expect(inbound[0]?.message.content).toBe(
      JSON.stringify({ text: '[twynoracle tool=twyn-query]\nfind this', sender: 'web', senderId: 'web:user-123' }),
    );
  });

  it('prefixes a mode-only selection on its own first line', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer mode-token' },
      body: JSON.stringify({ text: 'explain this', mode: 'eli5' }),
    });

    expect(response.status).toBe(202);
    expect(inbound[0]?.message.content).toBe(
      JSON.stringify({ text: '[twynoracle mode=eli5]\nexplain this', sender: 'web', senderId: 'web:user-123' }),
    );
  });

  it('prefixes both tool and mode selections on their own first line', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer both-token' },
      body: JSON.stringify({ text: 'explain this', tool: 'twyn-query', mode: 'eli5' }),
    });

    expect(response.status).toBe(202);
    expect(inbound[0]?.message.content).toBe(
      JSON.stringify({
        text: '[twynoracle tool=twyn-query mode=eli5]\nexplain this',
        sender: 'web',
        senderId: 'web:user-123',
      }),
    );
  });

  it.each([null, '', 'unknown', true, 1])('rejects invalid tool %j', async (tool) => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer invalid-tool-${String(tool)}` },
      body: JSON.stringify({ text: 'hello', tool }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid tool' });
    expect(inbound).toEqual([]);
  });

  it.each([null, '', 'unknown', true, 1])('rejects invalid mode %j', async (mode) => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer invalid-mode-${String(mode)}` },
      body: JSON.stringify({ text: 'hello', mode }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid mode' });
    expect(inbound).toEqual([]);
  });

  it('ignores an unrecognized developer field', async () => {
    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer developer-token' },
      body: JSON.stringify({ text: 'hello agent', developer: true }),
    });

    expect(response.status).toBe(202);
    expect(inbound[0]?.message.content).toBe(
      JSON.stringify({ text: 'hello agent', sender: 'web', senderId: 'web:user-123' }),
    );
  });

  it('sends fresh transcript rows as marked backfill', async () => {
    historyRows = [
      row('Slack question', '2026-09-04T10:00:00.000Z', 'in'),
      { ...row('Slack answer', '2026-09-04T10:00:01.000Z'), messageId: 'out-files', files: ['report.html'] },
    ];

    const stream = await openStream();

    await expect(stream.next()).resolves.toMatchObject({ text: 'Slack question', direction: 'in', backfill: true });
    await expect(stream.next()).resolves.toMatchObject({
      text: 'Slack answer',
      direction: 'out',
      messageId: 'out-files',
      files: ['report.html'],
      backfill: true,
    });
    await stream.close();
  });

  it('pushes a Slack-originated reply that appears in the transcript without deliver()', async () => {
    const stream = await openStream();
    await waitForInitialTranscriptRead();
    historyRows = [row('Seven', '2026-09-04T10:00:02.000Z')];

    await expect(stream.next()).resolves.toMatchObject({ text: 'Seven', direction: 'out', backfill: false });
    await stream.close();
  });

  it('delivers a web-originated outbound reply immediately through the transcript', async () => {
    const stream = await openStream();
    await waitForInitialTranscriptRead();
    historyRows = [row('agent reply', '2026-09-04T10:00:03.000Z')];

    await adapter.deliver('web:user-123', null, { kind: 'chat', content: { text: 'agent reply' } });

    await expect(stream.next()).resolves.toMatchObject({ text: 'agent reply', backfill: false });
    await stream.close();
  });

  it('does not render the same outbound row twice when deliver() and polling both see it', async () => {
    const stream = await openStream();
    await waitForInitialTranscriptRead();
    historyRows = [row('only once', '2026-09-04T10:00:04.000Z')];

    await adapter.deliver('web:user-123', null, { kind: 'chat', content: { text: 'only once' } });
    await expect(stream.next()).resolves.toMatchObject({ text: 'only once' });

    const noSecondEvent = await Promise.race([
      stream
        .next()
        .then(() => false)
        .catch(() => true),
      delay(80).then(() => true),
    ]);
    expect(noSecondEvent).toBe(true);
    await stream.close();
  });

  it('gives two connected browser clients independent complete transcript streams', async () => {
    historyRows = [row('shared history', '2026-09-04T10:00:05.000Z')];

    const first = await openStream('first-client');
    await expect(first.next()).resolves.toMatchObject({ text: 'shared history', backfill: true });
    const second = await openStream('second-client');
    await expect(second.next()).resolves.toMatchObject({ text: 'shared history', backfill: true });

    await first.close();
    await second.close();
  });

  it('stops transcript reads after the last SSE client disconnects', async () => {
    const stream = await openStream();
    await waitForInitialTranscriptRead();
    await stream.close();
    await delay(30);
    transcript.sessionHistory.mockClear();

    await delay(80);

    expect(transcript.sessionHistory).not.toHaveBeenCalled();
  });

  it('silently no-ops when no SSE client is connected', async () => {
    await expect(
      adapter.deliver('web:user-123', null, { kind: 'chat', content: { text: 'agent reply' } }),
    ).resolves.toBeUndefined();
  });

  it('accepts an EventSource query token on the SSE endpoint', async () => {
    const response = await nativeFetch(`${streamUrl()}?token=query-token`);

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it('bounds the rotating PocketBase token cache with oldest-token eviction', async () => {
    for (const token of ['one', 'two', 'three']) {
      const response = await nativeFetch(messageUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: token }),
      });
      expect(response.status).toBe(202);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const response = await nativeFetch(messageUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer one' },
      body: JSON.stringify({ text: 'one again' }),
    });

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('displayRow', () => {
  it('strips a leading steer line from inbound rows only', async () => {
    const { displayRow } = await import('./web.js');
    expect(displayRow({ direction: 'in', text: '[twynoracle tool=twyn-ask mode=eli5]\nhello' }).text).toBe('hello');
    expect(displayRow({ direction: 'in', text: 'plain' }).text).toBe('plain');
    expect(displayRow({ direction: 'out', text: '[twynoracle mode=eli5]\nx' }).text).toBe('[twynoracle mode=eli5]\nx');
  });
});
