/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import * as realConfig from '../config.js';
import type { DeliveryMode } from '../config.js';
import { getMaxOutboundSeq, getUndeliveredMessages, writeMessageOut } from '../db/messages-out.js';
import { sendMessage } from './core.js';

/**
 * The group's delivery mode, swapped per test.
 *
 * The real loadConfig() reads a fixed mount path and caches the first file it
 * saw, so a test cannot point it at a temp container.json without poisoning the
 * cache for the process. Mocking the module is per-file in bun, so the config
 * tests elsewhere still exercise the real loader.
 */
let deliveryMode: DeliveryMode = 'envelope';
/** Captured before the mock lands, so the override never calls itself. */
const realLoadConfig = realConfig.loadConfig;
mock.module(`${import.meta.dir}/../config.js`, () => ({
  ...realConfig,
  loadConfig: () => ({ ...realLoadConfig(), deliveryMode }),
}));

/** The text an MCP tool handed back. */
function resultText(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

/**
 * Publish the turn's outbound baseline the way the poll loop does — the same
 * direct DB write, since the MCP server cannot see the loop's module state.
 * The loop republishes this per turn, including when a follow-up batch is
 * pushed into a query that is already open.
 */
function publishTurnBaseline(seq: number): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('turn_outbound_baseline', String(seq), new Date().toISOString());
}

beforeEach(() => {
  deliveryMode = 'envelope';
  initTestSessionDb();
  // Seed two peer agent destinations — the second one is what proves a repeat
  // aimed somewhere else is a different message, not a duplicate.
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer'),
              ('other-peer', 'Other Peer', 'agent', NULL, NULL, 'ag-other-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

/**
 * A tools-only group delivers nothing except what an outbound tool call writes.
 * Small models can continue after a successful send and retry with paraphrases,
 * so exact-text dedupe is not a sufficient boundary. One plain send_message per
 * destination per turn is allowed; later attempts are acknowledged without a
 * write and told to stop rather than retry or rephrase.
 *
 * The turn boundary is the outbound baseline the poll loop publishes per turn,
 * not the in_reply_to stamp: that stamp is not refreshed when a follow-up batch
 * is pushed into an open query, so scoping to it would suppress the same short
 * answer given again much later in the life of one container. With no baseline
 * published there is nothing to scope to, and envelope groups keep their
 * existing behaviour.
 */
describe('send_message MCP tool — tools-only turn budget', () => {
  const TEXT = 'the deploy finished, all four checks green';

  it('writes one row and refuses the repeat when the same text is sent twice in a turn', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    const first = await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(TEXT);

    expect(resultText(first)).toContain(`(id: ${out[0].seq})`);
    expect(resultText(first)).toContain('Stop this turn now');
    expect(second.isError).toBeFalsy();
    expect(resultText(second)).toContain('Not sent');
    expect(resultText(second)).toContain('Do not retry, rephrase');
    expect(resultText(second)).toContain(`(id: ${out[0].seq})`);
  });

  it('treats a whitespace-only variation as the same message', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: `${TEXT}  \n` });

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(resultText(second)).toContain('Not sent');
  });

  it('refuses a paraphrased second message to the same destination', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: `${TEXT}, and the rollout is next` });

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(resultText(second)).toContain('Not sent');
    expect(resultText(second)).toContain('Stop this turn now');
  });

  it('lets the same text through to a different destination', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'other-peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });

  it('lets the same text through once a follow-up moves the baseline', async () => {
    deliveryMode = 'tools-only';
    publishTurnBaseline(0);
    await sendMessage.handler({ to: 'peer', text: TEXT });

    // What the poll loop does when it pushes a follow-up batch into a query
    // that is still open: same query, new turn.
    publishTurnBaseline(getMaxOutboundSeq());
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });

  it('ignores an identical row written before the turn began', async () => {
    deliveryMode = 'tools-only';
    // A send from an earlier turn, already on file when this turn starts.
    writeMessageOut({
      id: 'msg-earlier-turn',
      kind: 'chat',
      platform_id: 'ag-peer',
      channel_type: 'agent',
      thread_id: null,
      content: JSON.stringify({ text: TEXT }),
    });
    publishTurnBaseline(getMaxOutboundSeq());

    const result = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(result)).toContain('Message sent');
  });

  it('leaves envelope groups alone', async () => {
    // deliveryMode stays at the default from beforeEach.
    publishTurnBaseline(0);

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });

  it('does not suppress anything when no turn baseline is published', async () => {
    deliveryMode = 'tools-only';
    // No baseline: an ad-hoc invocation outside a batch has no turn to dedupe within.

    await sendMessage.handler({ to: 'peer', text: TEXT });
    const second = await sendMessage.handler({ to: 'peer', text: TEXT });

    expect(getUndeliveredMessages()).toHaveLength(2);
    expect(resultText(second)).toContain('Message sent');
  });
});
