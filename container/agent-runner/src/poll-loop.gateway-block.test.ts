import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const USAGE_CAP_MESSAGE =
  'Your organization’s AI usage limit has been reached. Please try again later or contact your administrator.';
const POLICY_DENIED_MESSAGE = 'Your organization’s AI policy blocked this request. Please contact your administrator.';

const USAGE_CAP_ERROR =
  'API Error: 429 {"type":"https://nanoco.ai/problems/usage-enforcement","title":"Usage enforcement blocked the request","status":429,"code":"usage_cap_reached"}';
const POLICY_DENIED_ERROR = 'API Error: 403 {"error":"policy_denied"}';

const SLACK_ROUTING = {
  platformId: 'C012345',
  channelType: 'slack',
  threadId: '1712345678.000100',
  inReplyTo: 'slack-message-1',
  taskRun: false,
};

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function resultQuery(text: string): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'result', text, isError: true };
  }
  return {
    pushes,
    query: {
      push(message) {
        pushes.push(message);
      },
      end() {},
      abort() {},
      events: events(),
    },
  };
}

function repeatedResultQuery(text: string): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'result', text, isError: true };
    yield { type: 'result', text, isError: true };
  }
  return {
    pushes,
    query: {
      push(message) {
        pushes.push(message);
      },
      end() {},
      abort() {},
      events: events(),
    },
  };
}

function outboundTexts(): string[] {
  return getUndeliveredMessages().map((row) => (JSON.parse(row.content) as { text: string }).text);
}

describe('Gateway provider blocks', () => {
  it('converts only 429 usage_cap_reached into one local Slack mailbox message without retrying', async () => {
    const { query, pushes } = resultQuery(USAGE_CAP_ERROR);

    await processQuery(query, SLACK_ROUTING, ['slack-message-1'], 'claude', undefined, 'prompt', undefined, true);

    expect(outboundTexts()).toEqual([USAGE_CAP_MESSAGE]);
    expect(getUndeliveredMessages()[0]).toMatchObject({
      kind: 'chat',
      platform_id: SLACK_ROUTING.platformId,
      channel_type: 'slack',
      thread_id: SLACK_ROUTING.threadId,
      in_reply_to: SLACK_ROUTING.inReplyTo,
    });
    expect(pushes).toHaveLength(0);
  });

  it('handles 403 policy_denied separately with a generic safe message', async () => {
    const { query, pushes } = resultQuery(POLICY_DENIED_ERROR);

    await processQuery(query, SLACK_ROUTING, ['slack-message-1'], 'claude', undefined, 'prompt', undefined, true);

    expect(outboundTexts()).toEqual([POLICY_DENIED_MESSAGE]);
    expect(pushes).toHaveLength(0);
  });

  it('does not expose usage totals or policy details from a recognized block', async () => {
    const detailed =
      'API Error: 429 {"status":429,"code":"usage_cap_reached","usage_total":987654,"policy":{"id":"private-policy"}}';
    const { query } = resultQuery(detailed);

    await processQuery(query, SLACK_ROUTING, ['slack-message-1'], 'claude', undefined, 'prompt', undefined, true);

    expect(outboundTexts()).toEqual([USAGE_CAP_MESSAGE]);
    expect(getUndeliveredMessages()[0].content).not.toContain('987654');
    expect(getUndeliveredMessages()[0].content).not.toContain('private-policy');
  });

  it('delivers one notice when the provider repeats the same terminal result', async () => {
    const { query, pushes } = repeatedResultQuery(USAGE_CAP_ERROR);

    await processQuery(query, SLACK_ROUTING, ['slack-message-1'], 'claude', undefined, 'prompt', undefined, true);

    expect(outboundTexts()).toEqual([USAGE_CAP_MESSAGE]);
    expect(pushes).toHaveLength(0);
  });

  it('does not classify a mismatched status/code pair', async () => {
    const mismatched = 'API Error: 403 {"status":403,"code":"usage_cap_reached"}';
    const { query } = resultQuery(mismatched);

    await processQuery(query, SLACK_ROUTING, ['slack-message-1'], 'claude', undefined, 'prompt', undefined, true);

    expect(outboundTexts()).toEqual([mismatched]);
  });

  it('acks the blocked turn so a fresh runner neither duplicates delivery nor queries again', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in
           (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES (?, 'chat', ?, 'pending', ?, 'slack', ?, ?)`,
      )
      .run(
        'slack-message-1',
        new Date().toISOString(),
        SLACK_ROUTING.platformId,
        SLACK_ROUTING.threadId,
        JSON.stringify({ sender: 'U012345', text: 'hello' }),
      );

    const provider = new BlockedProvider(USAGE_CAP_ERROR, true);
    await runUntil(() => getUndeliveredMessages().length === 1, provider);

    expect(outboundTexts()).toEqual([USAGE_CAP_MESSAGE]);
    expect(getPendingMessages()).toHaveLength(0);
    expect(provider.queryCalls).toBe(1);
    expect(provider.pushCalls).toBe(0);

    await runFor(1_100, provider);

    expect(outboundTexts()).toEqual([USAGE_CAP_MESSAGE]);
    expect(provider.queryCalls).toBe(1);
    expect(provider.pushCalls).toBe(0);
  });
});

class BlockedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  queryCalls = 0;
  pushCalls = 0;

  constructor(
    private readonly error: string,
    private readonly throwFromStream = false,
  ) {}

  query(): AgentQuery {
    this.queryCalls += 1;
    const owner = this;
    async function* events(): AsyncGenerator<ProviderEvent> {
      if (owner.throwFromStream) throw new Error(owner.error);
      yield { type: 'result', text: owner.error, isError: true };
    }
    return {
      push() {
        owner.pushCalls += 1;
      },
      end() {},
      abort() {},
      events: events(),
    };
  }

  isSessionInvalid(): boolean {
    return false;
  }
}

async function runUntil(condition: () => boolean, provider: AgentProvider, timeoutMs = 2_000): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'blocked-test', cwd: '/tmp', signal: controller.signal });
  const started = Date.now();
  while (!condition() && Date.now() - started < timeoutMs) await Bun.sleep(20);
  const matched = condition();
  controller.abort();
  await Promise.race([loop, Bun.sleep(250)]);
  if (!matched) throw new Error('runUntil timeout');
}

async function runFor(durationMs: number, provider: AgentProvider): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'blocked-test', cwd: '/tmp', signal: controller.signal });
  await Bun.sleep(durationMs);
  controller.abort();
  await Promise.race([loop, Bun.sleep(250)]);
}
