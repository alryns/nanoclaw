/**
 * Legacy runner-facing outbound API, backed by the registered mailbox.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { getAgentMailbox } from '../mailbox/index.js';
import type { OutboundMessage } from '../mailbox/types.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Extra entries merged into system-action payloads for the duration of a
 * call, without the writing handler knowing about them. This is the seam
 * `extendTool` (../mcp-tools/server.ts) uses so an installed module can
 * add params to a base tool and have them land in the tool's outbound
 * payload while the base tool's source stays untouched.
 *
 * Scope is deliberately narrow: only `kind: 'system'` messages whose
 * content parses to a JSON object are decorated, and entries never
 * overwrite keys the handler wrote itself. Everything else passes through
 * byte-identical. With no active context (the default), this is a no-op.
 */
const outboundPassthrough = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with `entries` merged into system-action payloads it writes. */
export function withOutboundPassthrough<T>(entries: Record<string, unknown>, fn: () => T): T {
  return outboundPassthrough.run(entries, fn);
}

/** Apply any active passthrough entries to a system-action JSON payload. */
function decorateContent(msg: WriteMessageOut): string {
  const entries = outboundPassthrough.getStore();
  if (!entries || msg.kind !== 'system') return msg.content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return msg.content;

  const payload = parsed as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = value;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : msg.content;
}

function messageRow(message: OutboundMessage): MessageOutRow {
  return {
    id: message.id,
    seq: message.sequence,
    in_reply_to: message.inReplyTo,
    timestamp: message.timestamp,
    deliver_after: message.deliverAfter,
    recurrence: message.recurrence,
    kind: message.kind,
    platform_id: message.platformId,
    channel_type: message.channelType,
    thread_id: message.threadId,
    content: message.content,
  };
}

export function writeMessageOut(msg: WriteMessageOut): Promise<number> {
  return getAgentMailbox().operations.writeMessageOut({
    id: msg.id,
    inReplyTo: msg.in_reply_to,
    deliverAfter: msg.deliver_after,
    recurrence: msg.recurrence,
    kind: msg.kind,
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
    content: decorateContent(msg),
  });
}

export function getMessageIdBySeq(seq: number): string | null {
  return getAgentMailbox().operations.getMessageIdBySeq(seq);
}

export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const routing = getAgentMailbox().operations.getRoutingBySeq(seq);
  return (
    routing && {
      channel_type: routing.channelType,
      platform_id: routing.platformId,
      thread_id: routing.threadId,
    }
  );
}

/**
 * Highest seq currently in messages_out. Used by the poll-loop to snapshot a
 * per-turn baseline: MCP tools (send_message, send_file, …) write outbound rows
 * directly and never touch the in-process `sent` counter, so a turn that
 * answered via a tool then ended with bare scratchpad looks identical to a
 * silent drop. Comparing this against a turn-start baseline reveals whether the
 * agent actually delivered anything out-of-band before the never-silent
 * fallback fires. Reads outbound only — inbound activity never moves it.
 */
export function getMaxOutboundSeq(): number {
  return getUndeliveredMessages().reduce((max, row) => Math.max(max, row.seq ?? 0), 0);
}

/**
 * Highest seq ABOVE `sinceSeq` on a row that put new content in front of a
 * person, or 0 when there is none.
 *
 * Narrower than getMaxOutboundSeq on purpose. Several outbound kinds move the
 * seq without answering anyone: `system` rows are internal bookkeeping,
 * `task_log` rows go to a run log, and an edit or a reaction rides on a `chat`
 * row while only annotating a message that already exists. Counting any of
 * those as an answer would let a turn that merely reacted pass as a reply,
 * leaving whoever asked with nothing.
 *
 * One call answers both "did anything land?" and "what is the new baseline?".
 * Reading those separately let a row committed by an out-of-process tool
 * between the two reads be absorbed into the baseline without ever counting as
 * a delivery. The scan is bounded by the caller's baseline; the cap only bites
 * on a pathological run of annotations, where returning 0 errs toward chasing
 * the turn rather than going quiet.
 */
const DELIVERY_SCAN_LIMIT = 200;

export function getDeliveredSeqSince(sinceSeq: number): number {
  const rows = getUndeliveredMessages()
    .filter((row) => (row.kind === 'chat' || row.kind === 'chat-sdk') && (row.seq ?? 0) > sinceSeq)
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, DELIVERY_SCAN_LIMIT);
  for (const row of rows) {
    if (row.seq !== null && isNewUserContent(row.content)) return row.seq;
  }
  return 0;
}

/** False for the operations that annotate an existing message. */
function isNewUserContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { operation?: string };
    return parsed.operation !== 'edit' && parsed.operation !== 'reaction';
  } catch {
    // A chat row we cannot parse is still a delivery the host will act on;
    // counting it avoids following a real reply with a redundant notice.
    return true;
  }
}

/**
 * Seq of an already-written chat row carrying the same text to the same
 * destination within the same turn, or null when there is none.
 *
 * `sinceSeq` is what scopes the lookup to one turn: it is the outbound baseline
 * the poll loop publishes when a turn starts, so only rows written during this
 * turn can match, and the same short answer given again an hour later counts as
 * a new message rather than a repeat. The in_reply_to stamp cannot serve as that
 * anchor — it is set when a query opens and is not refreshed when a follow-up
 * batch is pushed into a still-open query, so in a long-lived query it would
 * scope "this turn" to the whole life of the container.
 *
 * Scheduled rows (`deliver_after`) are excluded — those are queued for a later
 * moment and a same-text pair is legitimate.
 *
 * Routing is matched with `IS` rather than `=` because platform_id, channel_type
 * and thread_id are all nullable, and SQL equality against NULL is never true:
 * with `=`, two agent-channel sends with no thread would fail to match and the
 * duplicate would go out.
 *
 * The text comparison is trimmed, so whitespace-only variation still reads as
 * the same message. Rows whose content is not JSON, or carries no text, describe
 * something other than a plain chat send and are skipped.
 *
 * The scan is capped: past the cap the answer is "no duplicate", which delivers
 * a repeat rather than silently swallowing a distinct message.
 */
const DUPLICATE_SCAN_LIMIT = 100;

export function findDuplicateChatSend(opts: {
  sinceSeq: number;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  text: string;
}): number | null {
  const rows = getUndeliveredMessages()
    .filter(
      (row) =>
        row.kind === 'chat' &&
        row.deliver_after === null &&
        (row.seq ?? 0) > opts.sinceSeq &&
        row.platform_id === opts.platformId &&
        row.channel_type === opts.channelType &&
        row.thread_id === opts.threadId,
    )
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, DUPLICATE_SCAN_LIMIT);

  const wanted = opts.text.trim();
  for (const row of rows) {
    if (row.seq === null) continue;
    let text: unknown;
    try {
      text = (JSON.parse(row.content) as { text?: unknown }).text;
    } catch {
      continue;
    }
    if (typeof text === 'string' && text.trim() === wanted) return row.seq;
  }
  return null;
}

export function getUndeliveredMessages(): MessageOutRow[] {
  return getAgentMailbox().operations.getUndeliveredMessages().map(messageRow);
}
