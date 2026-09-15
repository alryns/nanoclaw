/**
 * `ncl sessions history <session-id>` — the pull layer of cross-session
 * context: full-depth catch-up on another conversation after the push
 * layer's one-line ambient copies.
 *
 * Reads the target session's inbound messages_in + outbound messages_out
 * (both read-only; safe with a live container) merged chronologically.
 *
 * SCOPING: custom operations bypass the dispatcher's generic post-handler
 * scope filter, so this handler self-scopes like tasks.ts `ownSession` —
 * an agent caller asking about another group's session gets the same
 * "session not found" as a nonexistent id (no cross-group existence oracle).
 */
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import { webHistoryControls } from '../../channels/web-turn-controls.js';
import type { CallerContext } from '../../cli/frame.js';

export const HISTORY_DEFAULT_LIMIT = 50;
/** Per-line text cap in the human pipe-separated rendering. */
export const HISTORY_TEXT_MAX_CHARS = 200;

export interface HistoryRow {
  /** ISO-8601 UTC on the wire; the human renderer localizes. */
  timestamp: string;
  direction: 'in' | 'out';
  kind: string;
  sender: string;
  text: string;
  /** Outbound message id, used for outbox files and stable transcript card updates. */
  messageId?: string;
  /** Web-only state, set only for a replaced member message. */
  replaced?: boolean;
  /** Declared outbound outbox filenames, when present. */
  files?: string[];
  /** TwynOracle fork: structured web-card data, never raw HTML. */
  card?: Record<string, unknown>;
}

function normalizeBefore(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value !== 'string') return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function cell(value: string): string {
  // Keep the one-line-per-message format intact: newlines and pipes in
  // message text would shred downstream line/field parsing.
  return value.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, HISTORY_TEXT_MAX_CHARS);
}

function parseText(raw: string): {
  text: string;
  sender: string | null;
  files?: string[];
  card?: Record<string, unknown>;
  hidden?: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text =
      typeof parsed.text === 'string' && parsed.text.length > 0
        ? parsed.text
        : typeof parsed.action === 'string'
          ? `[${parsed.action}]`
          : '';
    const files =
      Array.isArray(parsed.files) &&
      parsed.files.length > 0 &&
      parsed.files.every((file): file is string => typeof file === 'string')
        ? parsed.files
        : undefined;
    const card =
      parsed.type === 'ask_question' &&
      typeof parsed.questionId === 'string' &&
      typeof parsed.title === 'string' &&
      typeof parsed.question === 'string' &&
      Array.isArray(parsed.options)
        ? {
            type: 'question',
            questionId: parsed.questionId,
            title: parsed.title,
            question: parsed.question,
            options: parsed.options,
          }
        : parsed.type === 'card' && parsed.card && typeof parsed.card === 'object'
          ? { type: 'display', ...(parsed.card as Record<string, unknown>) }
          : undefined;
    return {
      text,
      sender: typeof parsed.sender === 'string' ? parsed.sender : null,
      files,
      card,
      // TwynOracle fork: bookkeeping rows, not messages (runner expiry, a card click's routed answer, a stop command).
      hidden:
        parsed.type === 'ask_question_expired' ||
        parsed.type === 'question_response' ||
        parsed.type === 'twyn_stop_turn',
    };
  } catch {
    return { text: raw, sender: null };
  }
}

/**
 * Handler for the sessions `history` custom operation. Returns the merged
 * transcript as structured rows (newest `limit`, chronological order, and
 * optionally no later than `before`) —
 * the frame `data`, so `--json` callers get real rows with ISO timestamps.
 * Human rendering (pipe lines, localized stamps, capped cells) lives in
 * `formatHistoryLines`, wired as the operation's `formatHuman`.
 */
export async function sessionHistory(args: Record<string, unknown>, ctx: CallerContext): Promise<HistoryRow[]> {
  const sessionId = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  if (!sessionId) throw new Error('session id is required');
  const limitRaw = Number(args.limit ?? HISTORY_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : HISTORY_DEFAULT_LIMIT;
  const before = normalizeBefore(args.before);

  const session = await getSession(sessionId);
  // Self-scope (see header): cross-group agents get "not found", never "forbidden".
  if (!session || (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId)) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? 'agent';
  const rows: HistoryRow[] = [];

  // TwynOracle fork: private outbox metadata supplies stop/replacement state.
  const webControls = await webHistoryControls(session);

  const history = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
    // The mailbox history API is newest-first only. A cutoff must therefore
    // read the complete transcript before it can select the preceding page.
    inbound: mailbox.getInboundHistory(before ? Number.MAX_SAFE_INTEGER : limit),
    outbound: mailbox.getOutboundHistory(before ? Number.MAX_SAFE_INTEGER : limit),
  }));

  if (history) {
    for (const r of history.inbound) {
      const metadata = webControls.takeInbound(r.timestamp, r.content);
      const { text, sender, hidden } = parseText(r.content);
      if (hidden) continue;
      rows.push({
        timestamp: r.timestamp,
        direction: 'in',
        kind: r.kind,
        sender: sender ?? '',
        text,
        ...(metadata ? { messageId: metadata.id } : {}),
        ...(metadata?.replaced ? { replaced: true } : {}),
      });
    }
    for (const r of history.outbound) {
      const metadata = webControls.takeOutbound(r.timestamp, r.content);
      if (metadata && (await webControls.isStoppedOutbound(metadata))) continue;
      const { text, files, card, hidden } = parseText(r.content);
      if (hidden) continue;
      rows.push({
        timestamp: r.timestamp,
        direction: 'out',
        kind: r.kind,
        sender: agentName,
        text,
        ...(metadata && (files || card) ? { messageId: metadata.id } : {}),
        ...(files ? { files } : {}),
        ...(card ? { card } : {}),
      });
    }
  }

  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const eligible = before ? rows.filter((row) => row.timestamp <= before) : rows;
  return eligible.slice(-limit);
}

/**
 * Human rendering: pipe-separated lines
 *   timestamp|direction(in/out)|kind|sender|text(first 200 chars)
 * with the timestamp in the install timezone (`timezone` injectable for
 * deterministic tests). `--json` bypasses this and gets the raw rows.
 */
export function formatHistoryLines(rows: HistoryRow[], timezone: string = TIMEZONE): string {
  return rows
    .map(
      (r) =>
        `${formatLocalStamp(new Date(r.timestamp), timezone)}|${r.direction}|${r.kind}|${cell(r.sender)}|${cell(r.text)}`,
    )
    .join('\n');
}
