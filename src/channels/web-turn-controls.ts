/**
 * TwynOracle fork: durable web stop/edit state. The runner remains the only
 * writer to a live session's outbound DB; this module uses the inbound mailbox
 * for the stop command and the central DB for the host delivery fence.
 */
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { isContainerRunning, killContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { registerMigration, type ModuleMigration } from '../db/migrations/index.js';
import { log } from '../log.js';
import { inboundDbPath, outboundDbPath } from '../mailbox/sqlite/paths.js';
import { ABSOLUTE_CEILING_MS } from '../reconcile-session.js';
import {
  heartbeatPath,
  withExistingMailboxSession,
  writeOutboundDirect,
  writeSessionMessage,
} from '../session-manager.js';
import { stopWebQuestions } from './web-cards.js';

const STOP_COMMAND_TYPE = 'twyn_stop_turn';
const TURN_INPUT_FIELD = 'twynTurnInputId';
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const RUNNER_STATUS_FILENAME = '.status';
const HEARTBEAT_FRESH_MS = 6_000;
const ACTIVE_TURN_FILENAME = '.twyn-active-turn';

export const webTurnControlsMigration: ModuleMigration = {
  version: 1,
  name: 'module:twyn-web:turn-controls',
  async up(db) {
    await db.exec(`
      CREATE TABLE web_stopped_turns (
        session_id TEXT NOT NULL,
        in_reply_to TEXT NOT NULL,
        stopped_at TEXT NOT NULL,
        outbound_sequence INTEGER NOT NULL,
        PRIMARY KEY (session_id, in_reply_to)
      );
      CREATE INDEX idx_web_stopped_turns_session ON web_stopped_turns(session_id);
      CREATE TABLE web_message_replacements (
        original_message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        replacement_message_id TEXT NOT NULL,
        replaced_at TEXT NOT NULL
      );
      CREATE INDEX idx_web_message_replacements_session ON web_message_replacements(session_id);
    `);
  },
};

registerMigration(webTurnControlsMigration);

export interface WebSessionRef {
  id: string;
  agent_group_id: string;
}

interface InboundSnapshot {
  id: string;
  sequence: number | null;
  timestamp: string;
  status: string;
  kind: string;
  content: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

interface OutboundSnapshot {
  id: string;
  sequence: number | null;
  timestamp: string;
  content: string;
  inReplyTo: string | null;
}

interface ActiveTurn {
  inputIds: string[];
  outboundSequence: number;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

interface RunnerActiveTurn {
  inputId: string | null;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  startedAtMs: number | null;
}

export interface WebTurnRunningEvidence {
  containerRunning: boolean;
  heartbeatFresh: boolean;
  hasWorkingStatus: boolean;
  hasRunnerTurn: boolean;
  hasClaim: boolean;
}

export interface StopTurnResult {
  stopped: boolean;
  noticeId?: string;
  /** Question rows that the web stream must re-emit with their stopped state. */
  stoppedQuestionIds?: string[];
}

export interface WebTurnControlsOptions {
  graceMs?: number;
}

const STOP_GRACE_MS = 10_000;

function isConversationMessage(row: InboundSnapshot): boolean {
  return (
    (row.kind === 'chat' || row.kind === 'chat-sdk') &&
    row.channelType !== 'session-echo' &&
    row.channelType !== 'agent'
  );
}

function parseSender(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const sender = (parsed as Record<string, unknown>).sender;
    return typeof sender === 'string' ? sender : null;
  } catch {
    return null;
  }
}

function snapshotTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function readRunnerActiveTurn(session: WebSessionRef): RunnerActiveTurn | null {
  const activePath = path.join(path.dirname(heartbeatPath(session.agent_group_id, session.id)), ACTIVE_TURN_FILENAME);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    return {
      inputId: nullableText(value.inputId),
      platformId: nullableText(value.platformId),
      channelType: nullableText(value.channelType),
      threadId: nullableText(value.threadId),
      startedAtMs:
        typeof value.startedAtMs === 'number' && Number.isSafeInteger(value.startedAtMs) ? value.startedAtMs : null,
    };
  } catch {
    return null;
  }
}

async function runnerTurnWithinCeiling(session: WebSessionRef, turn: RunnerActiveTurn | null): Promise<boolean> {
  if (!turn?.inputId || turn.startedAtMs === null || turn.startedAtMs > Date.now()) return false;
  const state = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getContainerState(),
  );
  const declaredBashMs = state?.currentTool === 'Bash' ? (state.toolDeclaredTimeoutMs ?? 0) : 0;
  return Date.now() - turn.startedAtMs <= Math.max(ABSOLUTE_CEILING_MS, declaredBashMs);
}

function isHeartbeatFresh(session: WebSessionRef): boolean {
  try {
    return Date.now() - fs.statSync(heartbeatPath(session.agent_group_id, session.id)).mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

function hasWorkingStatus(session: WebSessionRef): boolean {
  const statusPath = path.join(path.dirname(heartbeatPath(session.agent_group_id, session.id)), RUNNER_STATUS_FILENAME);
  try {
    return fs.readFileSync(statusPath, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/** The single host predicate used by both SSE state and the stop route. */
export function webTurnIsRunning(evidence: WebTurnRunningEvidence): boolean {
  return (
    evidence.hasClaim ||
    (evidence.containerRunning && (evidence.hasRunnerTurn || (evidence.heartbeatFresh && evidence.hasWorkingStatus)))
  );
}

/** TwynOracle fork: the shared mailbox history contract stays deliberately small. */
function readInboundSnapshots(session: WebSessionRef): InboundSnapshot[] {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
    return (
      db
        .prepare(
          `SELECT id, seq AS sequence, timestamp, status, kind, content,
                platform_id AS platformId, channel_type AS channelType, thread_id AS threadId
           FROM messages_in ORDER BY seq DESC`,
        )
        .all() as InboundSnapshot[]
    ).map((row) => ({ ...row, timestamp: snapshotTimestamp(row.timestamp) }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** TwynOracle fork: inspect durable outbox metadata without widening OutboundDelivery. */
function readOutboundSnapshots(session: WebSessionRef, messageId?: string): OutboundSnapshot[] {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(outboundDbPath(session.agent_group_id, session.id), { readonly: true });
    const query = messageId
      ? 'SELECT id, seq AS sequence, timestamp, content, in_reply_to AS inReplyTo FROM messages_out WHERE id = ?'
      : 'SELECT id, seq AS sequence, timestamp, content, in_reply_to AS inReplyTo FROM messages_out ORDER BY seq DESC';
    return ((messageId ? db.prepare(query).all(messageId) : db.prepare(query).all()) as OutboundSnapshot[]).map(
      (row) => ({
        ...row,
        timestamp: snapshotTimestamp(row.timestamp),
      }),
    );
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** TwynOracle fork: delivery retries rather than failing open if this read is unavailable. */
function readOutboundSnapshotForFence(session: WebSessionRef, messageId: string): OutboundSnapshot | undefined {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(outboundDbPath(session.agent_group_id, session.id), { readonly: true });
    const row = db
      .prepare(
        'SELECT id, seq AS sequence, timestamp, content, in_reply_to AS inReplyTo FROM messages_out WHERE id = ?',
      )
      .get(messageId) as OutboundSnapshot | undefined;
    return row && { ...row, timestamp: snapshotTimestamp(row.timestamp) };
  } finally {
    db?.close();
  }
}

async function claimedTurn(session: WebSessionRef): Promise<ActiveTurn | null> {
  const claims = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getProcessingClaims(),
  );
  if (!claims || claims.length === 0) return null;
  const claimed = new Set(claims.map(({ messageId }) => messageId));
  const rows = readInboundSnapshots(session)
    .filter((row) => claimed.has(row.id))
    .filter(isConversationMessage)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const first = rows[0];
  if (!first) return null;
  const latestOutbound = readOutboundSnapshots(session)[0];
  return {
    inputIds: rows.map((row) => row.id),
    outboundSequence: latestOutbound?.sequence ?? 0,
    platformId: first.platformId,
    channelType: first.channelType,
    threadId: first.threadId,
  };
}

function latestConversationTurn(session: WebSessionRef): ActiveTurn | null {
  const input = readInboundSnapshots(session).find(isConversationMessage);
  if (!input) return null;
  return {
    inputIds: [input.id],
    outboundSequence: readOutboundSnapshots(session)[0]?.sequence ?? 0,
    platformId: input.platformId,
    channelType: input.channelType,
    threadId: input.threadId,
  };
}

/**
 * TwynOracle fork: a cold container has no processing claim or active-turn
 * sidecar yet. These durable, unacknowledged inputs are still cancellable.
 */
function pendingConversationTurns(session: WebSessionRef): ActiveTurn[] {
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(outboundDbPath(session.agent_group_id, session.id), { readonly: true });
    const acknowledged = new Set(
      (db.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        ({ message_id }) => message_id,
      ),
    );
    const outboundSequence = readOutboundSnapshots(session)[0]?.sequence ?? 0;
    return readInboundSnapshots(session)
      .filter((row) => row.status === 'pending' && !acknowledged.has(row.id))
      .filter(isConversationMessage)
      .map((row) => ({
        inputIds: [row.id],
        outboundSequence,
        platformId: row.platformId,
        channelType: row.channelType,
        threadId: row.threadId,
      }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

async function webTurnState(session: WebSessionRef): Promise<{ running: boolean; turn: ActiveTurn | null }> {
  const claim = await claimedTurn(session);
  const runnerTurn = readRunnerActiveTurn(session);
  const hasRunnerTurn = await runnerTurnWithinCeiling(session, runnerTurn);
  const running = webTurnIsRunning({
    containerRunning: isContainerRunning(session.id),
    heartbeatFresh: isHeartbeatFresh(session),
    hasWorkingStatus: hasWorkingStatus(session),
    // Only the runner's durable input id is activity evidence. A malformed
    // active-turn record must not hold the web session in its running state.
    hasRunnerTurn,
    hasClaim: claim !== null,
  });
  if (!running) return { running: false, turn: null };

  const outboundSequence = readOutboundSnapshots(session)[0]?.sequence ?? 0;
  if (hasRunnerTurn && runnerTurn?.inputId) {
    return {
      running: true,
      turn: {
        inputIds: [runnerTurn.inputId],
        outboundSequence,
        platformId: runnerTurn.platformId,
        channelType: runnerTurn.channelType,
        threadId: runnerTurn.threadId,
      },
    };
  }
  // The runner record is written before a live query can poll for stop. The
  // fallback preserves stop for a pre-record runner or a damaged status file.
  return { running: true, turn: claim ?? latestConversationTurn(session) };
}

/** TwynOracle fork: shared running predicate for web SSE and POST /web/stop. */
export async function hasActiveWebTurn(session: WebSessionRef): Promise<boolean> {
  return (await webTurnState(session)).running;
}

async function writeStoppedNotice(session: WebSessionRef, turn: ActiveTurn, noticeId: string): Promise<void> {
  await writeOutboundDirect(session.agent_group_id, session.id, {
    id: noticeId,
    kind: 'chat',
    platformId: turn.platformId,
    channelType: turn.channelType,
    threadId: turn.threadId,
    content: JSON.stringify({ type: 'twyn_turn_stopped', text: 'Stopped' }),
  });
}

async function scheduleGraceKill(
  session: WebSessionRef,
  commandId: string,
  noticeId: string,
  turn: ActiveTurn,
  noticeAlreadyWritten: boolean,
  graceMs: number,
): Promise<void> {
  setTimeout(() => {
    void (async () => {
      try {
        // The runner acks the command as soon as it reads it, before the interrupt lands, so the
        // ack only says who writes the notice. Whether the turn wound down is the active-turn
        // record: still naming a stopped input means a tool outlived interrupt(). A record naming
        // any other input is the next turn, which must never be killed.
        const acknowledged =
          (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
            mailbox.getTerminalProcessingAcks().some((ack) => ack.messageId === commandId),
          )) ?? false;
        const writeNotice = !acknowledged && !noticeAlreadyWritten;
        const activeInputId = readRunnerActiveTurn(session)?.inputId ?? null;
        const stuck = activeInputId !== null && turn.inputIds.includes(activeInputId);
        if (!stuck || !isContainerRunning(session.id)) {
          if (writeNotice) await writeStoppedNotice(session, turn, noticeId);
          return;
        }
        // The fallback deliberately does not respawn. The stored continuation
        // remains in the session mailbox and the next member message wakes it.
        killContainer(session.id, 'web-stop-grace', () => {
          if (writeNotice) {
            writeStoppedNotice(session, turn, noticeId).catch((err) => log.warn('Web stop notice failed', { err }));
          }
        });
      } catch (err) {
        log.warn('Web stop grace check failed', { err, sessionId: session.id });
      }
    })();
  }, graceMs).unref();
}

/** Request a stop only for this resolved session. A missing turn is a no-op. */
export async function requestWebTurnStop(
  session: WebSessionRef,
  options: WebTurnControlsOptions = {},
): Promise<StopTurnResult> {
  const state = await webTurnState(session);
  const pending = pendingConversationTurns(session);
  const liveTurn = state.running ? state.turn : null;
  // A pending row is ordered newest-first by the inbound read. It supplies
  // routing for the cold-start notice, while an active turn keeps its own
  // original reply surface.
  const turn = liveTurn ?? pending[0];
  if (!turn) return { stopped: false };

  const inputIds = [...new Set([...(liveTurn?.inputIds ?? []), ...pending.flatMap((entry) => entry.inputIds)])];
  const cancelledInputIds = pending.map((entry) => entry.inputIds[0]);
  const outboundSequence = liveTurn?.outboundSequence ?? turn.outboundSequence;

  const stoppedAt = new Date().toISOString();
  const noticeId = `web-stopped-${randomUUID()}`;
  const commandId = `web-stop-${randomUUID()}`;
  // Two tabs pressing Stop on the same turn: the second finds every input already fenced inside
  // the grace window and returns without a second command or notice. Once the window has passed
  // without the turn ending, pressing Stop again sends a fresh command and grace kill.
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  let alreadyStopped = false;
  await getDb().transaction(async () => {
    const fenced = await getDb().all<{ in_reply_to: string }>(
      'SELECT in_reply_to FROM web_stopped_turns WHERE session_id = ? AND stopped_at > ?',
      session.id,
      new Date(Date.now() - graceMs).toISOString(),
    );
    const recent = new Set(fenced.map((row) => row.in_reply_to));
    if (inputIds.every((inputId) => recent.has(inputId))) {
      alreadyStopped = true;
      return;
    }
    for (const inputId of inputIds) {
      await getDb().run(
        `INSERT INTO web_stopped_turns (session_id, in_reply_to, stopped_at, outbound_sequence)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, in_reply_to) DO UPDATE SET stopped_at = excluded.stopped_at`,
        session.id,
        inputId,
        stoppedAt,
        outboundSequence,
      );
    }
  });
  if (alreadyStopped) return { stopped: true };
  const stoppedQuestionIds = await stopWebQuestions(session.id);
  // No runner can consume a cold-start command promptly enough to make its
  // notice reliable. Write it now, then tell the runner not to duplicate it.
  const noticeAlreadyWritten = liveTurn === null;
  if (noticeAlreadyWritten) await writeStoppedNotice(session, turn, noticeId);
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: commandId,
    kind: 'system',
    timestamp: stoppedAt,
    platformId: turn.platformId,
    channelType: turn.channelType,
    threadId: turn.threadId,
    content: JSON.stringify({
      type: STOP_COMMAND_TYPE,
      noticeId,
      platformId: turn.platformId,
      channelType: turn.channelType,
      threadId: turn.threadId,
      cancelInputIds: cancelledInputIds,
      noticeAlreadyWritten,
    }),
    trigger: true,
  });
  await scheduleGraceKill(session, commandId, noticeId, turn, noticeAlreadyWritten, graceMs);
  return { stopped: true, noticeId, ...(stoppedQuestionIds.length ? { stoppedQuestionIds } : {}) };
}

async function isStoppedTurnOutputAt(
  sessionId: string,
  inReplyTo: string | null,
  timestamp: string,
  sequence: number | null,
): Promise<boolean> {
  if (!inReplyTo) return false;
  const row = await getDb().get<{ stopped_at: string; outbound_sequence: number }>(
    'SELECT stopped_at, outbound_sequence FROM web_stopped_turns WHERE session_id = ? AND in_reply_to = ?',
    sessionId,
    inReplyTo,
  );
  if (!row) return false;
  return sequence === null ? timestamp > row.stopped_at : sequence > row.outbound_sequence;
}

/**
 * A multi-destination reply keeps its destination's reply id for thread
 * routing, so the runner carries the originating turn in the otherwise
 * display-inert outbound JSON. All other output uses `in_reply_to` itself.
 */
export function turnInputForOutput(inReplyTo: string | null, content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)[TURN_INPUT_FIELD];
      if (typeof value === 'string' && value) return value;
    }
  } catch {
    // Non-JSON outbox content has no hidden turn marker.
  }
  return inReplyTo;
}

/**
 * TwynOracle fork: resolve the durable outbox row here rather than changing
 * the shared outbound delivery shape for every channel.
 */
export async function isStoppedTurnOutput(
  session: WebSessionRef,
  messageId: string,
  inReplyTo: string | null,
  content: string,
): Promise<boolean> {
  const output = readOutboundSnapshotForFence(session, messageId);
  if (!output) return false;
  const turnInput = turnInputForOutput(output.inReplyTo ?? inReplyTo, output.content || content);
  return isStoppedTurnOutputAt(session.id, turnInput, output.timestamp, output.sequence);
}

function historyKey(timestamp: string, content: string): string {
  return `${timestamp}\u0000${content}`;
}

function rowsByHistoryKey<T extends { timestamp: string; content: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = historyKey(row.timestamp, row.content);
    const matches = grouped.get(key) ?? [];
    matches.push(row);
    grouped.set(key, matches);
  }
  return grouped;
}

function takeHistoryRow<T>(rows: Map<string, T[]>, timestamp: string, content: string): T | undefined {
  const matches = rows.get(historyKey(timestamp, content));
  if (!matches || matches.length === 0) return undefined;
  return matches.shift();
}

interface WebHistoryInbound extends InboundSnapshot {
  replaced: boolean;
}

export interface WebHistoryControls {
  takeInbound(timestamp: string, content: string): WebHistoryInbound | undefined;
  takeOutbound(timestamp: string, content: string): OutboundSnapshot | undefined;
  isStoppedOutbound(output: OutboundSnapshot): Promise<boolean>;
}

/** TwynOracle fork: add private transcript metadata without widening MailboxHistoryMessage. */
export async function webHistoryControls(session: WebSessionRef): Promise<WebHistoryControls> {
  const [replacementRows, outbound] = await Promise.all([
    getDb().all<{ original_message_id: string }>(
      'SELECT original_message_id FROM web_message_replacements WHERE session_id = ?',
      session.id,
    ),
    Promise.resolve(readOutboundSnapshots(session)),
  ]);
  const replacements = new Set(replacementRows.map((row) => row.original_message_id));
  const inbound = readInboundSnapshots(session).map((row) => ({ ...row, replaced: replacements.has(row.id) }));
  const inboundByHistory = rowsByHistoryKey(inbound);
  const outboundByHistory = rowsByHistoryKey(outbound);
  return {
    takeInbound: (timestamp, content) => takeHistoryRow(inboundByHistory, timestamp, content),
    takeOutbound: (timestamp, content) => takeHistoryRow(outboundByHistory, timestamp, content),
    isStoppedOutbound: async (output) =>
      isStoppedTurnOutputAt(
        session.id,
        turnInputForOutput(output.inReplyTo, output.content),
        output.timestamp,
        output.sequence,
      ),
  };
}

/** The member's own web-typed message is still the newest conversation input in the session. */
export function isLatestWebMessage(session: WebSessionRef, platformId: string, messageId: string): boolean {
  const latest = readInboundSnapshots(session).find(isConversationMessage);
  return Boolean(
    latest && latest.id === messageId && latest.platformId === platformId && parseSender(latest.content) === 'web',
  );
}

/** Web-only edit eligibility. A Slack latest message intentionally has no edit control. */
export async function canReplaceLatestWebMessage(
  session: WebSessionRef,
  platformId: string,
  messageId: string,
): Promise<boolean> {
  if (!isLatestWebMessage(session, platformId, messageId)) return false;
  const replacement = await getDb().get<{ original_message_id: string }>(
    'SELECT original_message_id FROM web_message_replacements WHERE original_message_id = ?',
    messageId,
  );
  return !replacement;
}

export async function reserveWebMessageReplacement(
  session: WebSessionRef,
  originalMessageId: string,
  replacementMessageId: string,
): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO web_message_replacements
       (original_message_id, session_id, replacement_message_id, replaced_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(original_message_id) DO NOTHING`,
    originalMessageId,
    session.id,
    replacementMessageId,
    new Date().toISOString(),
  );
  return result.changes > 0;
}

export async function releaseWebMessageReplacement(
  originalMessageId: string,
  replacementMessageId: string,
): Promise<void> {
  await getDb().run(
    'DELETE FROM web_message_replacements WHERE original_message_id = ? AND replacement_message_id = ?',
    originalMessageId,
    replacementMessageId,
  );
}
