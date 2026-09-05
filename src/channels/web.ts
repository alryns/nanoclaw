/**
 * Web channel — authenticated browser access to a cohort member's agent.
 *
 * The SPA posts user messages here and holds an SSE connection for the shared
 * session transcript. Provisioning wires web:<PocketBase user id> and Slack to
 * the same agent group with session_mode='agent-shared', so the existing
 * session model supplies session unity without a web-specific key.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { TWYN_POCKETBASE_URL, TWYN_WEB_HOST, TWYN_WEB_PORT } from '../config.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionByAgentGroup } from '../db/sessions.js';
import { log } from '../log.js';
import { HISTORY_DEFAULT_LIMIT, sessionHistory, type HistoryRow } from '../modules/cross-session-context/index.js';
import { readOutboxFiles } from '../session-manager.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const AUTH_CACHE_MS = 60_000;
const VERIFIED_USERS_MAX = 512;
const HEARTBEAT_MS = 25_000;
const TRANSCRIPT_POLL_MS = 1_000;
const WEB_TOOLS = new Set(['twyn-ask', 'twyn-query', 'twyn-portal-nav', 'twyn-repo-ask']);
const WEB_MODES = new Set(['standard', 'simple', 'eli5', 'showme']);

/**
 * A browser session is a private authenticated DM: every submitted message is
 * for the agent (pattern '.'), PocketBase authentication establishes a known
 * sender ('public'), and the browser has no platform thread concept. Group
 * values mirror DM defensively, although this adapter never creates groups.
 */
const WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

interface VerifiedUser {
  id: string;
  expiresAt: number;
}

interface TranscriptHighWaterMark {
  timestamp: string;
  fingerprints: Set<string>;
}

interface WebStreamClient {
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
  sessionId: string | null;
  highWaterMark: TranscriptHighWaterMark | null;
  needsBackfill: boolean;
}

export interface WebAdapterOptions {
  /** Test-only overrides keep production on its configured port and one-second poll cadence. */
  port?: number;
  pollIntervalMs?: number;
  tokenCacheMax?: number;
}

function platformIdFor(userId: string): string {
  return `web:${userId}`;
}

function extractBearer(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return url.searchParams.get('token');
}

function historyLimit(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return HISTORY_DEFAULT_LIMIT;
  return Math.min(Number(value), 200);
}

function historyBefore(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function fileResponseType(filename: string): { contentType: string; inline: boolean; sandbox: boolean } {
  switch (path.extname(filename).toLowerCase()) {
    case '.html':
      return { contentType: 'text/html; charset=utf-8', inline: true, sandbox: true };
    case '.svg':
      return { contentType: 'image/svg+xml', inline: true, sandbox: true };
    case '.png':
      return { contentType: 'image/png', inline: true, sandbox: false };
    case '.jpg':
    case '.jpeg':
      return { contentType: 'image/jpeg', inline: true, sandbox: false };
    case '.gif':
      return { contentType: 'image/gif', inline: true, sandbox: false };
    case '.webp':
      return { contentType: 'image/webp', inline: true, sandbox: false };
    case '.pdf':
      return { contentType: 'application/pdf', inline: true, sandbox: false };
    case '.md':
      return { contentType: 'text/markdown; charset=utf-8', inline: true, sandbox: false };
    case '.txt':
      return { contentType: 'text/plain; charset=utf-8', inline: true, sandbox: false };
    case '.csv':
      return { contentType: 'text/csv; charset=utf-8', inline: true, sandbox: false };
    case '.json':
      return { contentType: 'application/json; charset=utf-8', inline: true, sandbox: false };
    default:
      return { contentType: 'application/octet-stream', inline: false, sandbox: false };
  }
}

function contentDispositionFilename(filename: string): string {
  // Control characters are exactly what must not reach a header value.
  // eslint-disable-next-line no-control-regex
  return filename.replace(/["\\\x00-\x1F\x7F]/g, '_');
}

function isSafeVaultPath(value: string | null): value is string {
  return (
    typeof value === 'string' &&
    value.endsWith('.md') &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('\\') &&
    /^[A-Za-z0-9._/-]+$/.test(value)
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 1_000_000) throw new Error('request body too large');
  }
  return JSON.parse(body);
}

function sendStatus(res: ServerResponse, status: number, error?: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: error ?? (status === 401 ? 'unauthorized' : 'bad request') }));
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

function rowFingerprint(row: HistoryRow): string {
  return JSON.stringify([row.direction, row.kind, row.sender, row.text]);
}

function rowIsNewer(row: HistoryRow, highWaterMark: TranscriptHighWaterMark | null): boolean {
  if (!highWaterMark || row.timestamp > highWaterMark.timestamp) return true;
  if (row.timestamp < highWaterMark.timestamp) return false;
  return !highWaterMark.fingerprints.has(rowFingerprint(row));
}

function markRowSent(row: HistoryRow, highWaterMark: TranscriptHighWaterMark | null): TranscriptHighWaterMark {
  const fingerprint = rowFingerprint(row);
  if (!highWaterMark || row.timestamp > highWaterMark.timestamp) {
    return { timestamp: row.timestamp, fingerprints: new Set([fingerprint]) };
  }
  if (row.timestamp === highWaterMark.timestamp) highWaterMark.fingerprints.add(fingerprint);
  return highWaterMark;
}

export function createWebAdapter(options: WebAdapterOptions = {}): ChannelAdapter {
  const port = options.port ?? TWYN_WEB_PORT;
  const pollIntervalMs = options.pollIntervalMs ?? TRANSCRIPT_POLL_MS;
  const tokenCacheMax = options.tokenCacheMax ?? VERIFIED_USERS_MAX;
  let server: http.Server | null = null;
  const streams = new Map<string, Set<WebStreamClient>>();
  const pollers = new Map<string, NodeJS.Timeout>();
  const activeRefreshes = new Map<string, Promise<void>>();
  const verifiedUsers = new Map<string, VerifiedUser>();

  function pruneVerifiedUsers(now: number): void {
    for (const [token, user] of verifiedUsers) {
      if (user.expiresAt <= now) verifiedUsers.delete(token);
    }
  }

  function cacheVerifiedUser(token: string, userId: string): void {
    const now = Date.now();
    pruneVerifiedUsers(now);
    // Tokens rotate frequently. The hard cap prevents a public listener from
    // retaining an unbounded number of otherwise short-lived bearer tokens.
    while (verifiedUsers.size >= tokenCacheMax) {
      const oldest = verifiedUsers.keys().next().value;
      if (oldest === undefined) break;
      verifiedUsers.delete(oldest);
    }
    verifiedUsers.set(token, { id: userId, expiresAt: now + AUTH_CACHE_MS });
  }

  async function verifyToken(token: string): Promise<string | null> {
    pruneVerifiedUsers(Date.now());
    const cached = verifiedUsers.get(token);
    if (cached) return cached.id;

    try {
      // POST: PocketBase only serves auth-refresh as POST; a GET falls through to the SPA
      // and returns index.html, which read as "token invalid" until this was fixed.
      const response = await fetch(`${TWYN_POCKETBASE_URL}/api/collections/users/auth-refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      const id =
        payload &&
        typeof payload === 'object' &&
        'record' in payload &&
        payload.record &&
        typeof payload.record === 'object' &&
        'id' in payload.record &&
        typeof payload.record.id === 'string'
          ? payload.record.id
          : null;
      if (!id) return null;
      cacheVerifiedUser(token, id);
      return id;
    } catch (err) {
      // PocketBase is the signature authority. A transport or parsing failure
      // must not degrade into accepting a token the host could not verify.
      log.warn('Web channel token verification failed', { err });
      return null;
    }
  }

  async function resolveSession(platformId: string): Promise<{ id: string; agent_group_id: string } | null> {
    const messagingGroup = await getMessagingGroupByPlatform('web', platformId);
    if (!messagingGroup) return null;
    const [wiring] = await getMessagingGroupAgents(messagingGroup.id);
    if (!wiring) return null;
    return (await findSessionByAgentGroup(wiring.agent_group_id)) ?? null;
  }

  function emitTranscript(client: WebStreamClient, row: HistoryRow, backfill: boolean): void {
    if (client.response.writableEnded) return;
    client.response.write(`data: ${JSON.stringify({ ...row, backfill })}\n\n`);
    client.highWaterMark = markRowSent(row, client.highWaterMark);
  }

  async function refreshTranscript(platformId: string): Promise<void> {
    const existing = activeRefreshes.get(platformId);
    if (existing) return existing;

    const refresh = (async () => {
      const clients = streams.get(platformId);
      if (!clients?.size) return;
      const session = await resolveSession(platformId);
      if (!session) return;
      const rows = await sessionHistory({ id: session.id, limit: HISTORY_DEFAULT_LIMIT }, { caller: 'host' });

      for (const client of clients) {
        if (client.response.writableEnded) continue;
        if (client.sessionId !== session.id) {
          client.sessionId = session.id;
          client.highWaterMark = null;
          client.needsBackfill = true;
        }
        const backfill = client.needsBackfill;
        for (const row of rows) {
          if (backfill || rowIsNewer(row, client.highWaterMark)) emitTranscript(client, row, backfill);
        }
        client.needsBackfill = false;
      }
    })()
      .catch((err) => {
        log.warn('Web channel transcript refresh failed', { err, platformId });
      })
      .finally(() => {
        activeRefreshes.delete(platformId);
      });
    activeRefreshes.set(platformId, refresh);
    return refresh;
  }

  function stopPoller(platformId: string): void {
    const poller = pollers.get(platformId);
    if (!poller) return;
    clearInterval(poller);
    pollers.delete(platformId);
  }

  function addStream(platformId: string, response: ServerResponse): void {
    let clients = streams.get(platformId);
    if (!clients) {
      clients = new Set();
      streams.set(platformId, clients);
    }
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const client: WebStreamClient = {
      response,
      heartbeat,
      sessionId: null,
      highWaterMark: null,
      needsBackfill: true,
    };
    clients.add(client);

    if (!pollers.has(platformId)) {
      const poller = setInterval(() => {
        void refreshTranscript(platformId);
      }, pollIntervalMs);
      poller.unref();
      pollers.set(platformId, poller);
    }
    void refreshTranscript(platformId);

    response.on('close', () => {
      clearInterval(heartbeat);
      clients?.delete(client);
      if (clients?.size === 0) {
        streams.delete(platformId);
        stopPoller(platformId);
      }
    });
  }

  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: 'web',
    supportsThreads: false,
    defaults: WEB_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      server = http.createServer((req, res) => {
        void handleRequest(req, res, config);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, TWYN_WEB_HOST, () => {
          log.info('Web channel listening', { host: TWYN_WEB_HOST, port });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const poller of pollers.values()) clearInterval(poller);
      pollers.clear();
      for (const clients of streams.values()) {
        for (const client of clients) {
          clearInterval(client.heartbeat);
          client.response.end();
        }
      }
      streams.clear();
      if (server) {
        // Idle keep-alive sockets would otherwise outlive the listener and fail their next
        // request on reuse (seen in the suite: per-test servers on one port, "other side closed").
        const closing = new Promise<void>((resolve) => server!.close(() => resolve()));
        server.closeAllConnections();
        await closing;
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (extractText(message) === null || !streams.has(platformId)) return undefined;
      // Delivery runs after the outbound row is durable. Refreshing now sends
      // its canonical transcript row immediately; the per-client high-water
      // mark means the one-second poll cannot render it a second time.
      await refreshTranscript(platformId);
      return undefined;
    },
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse, config: ChannelSetup): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (
      (url.pathname !== '/web/message' &&
        url.pathname !== '/web/stream' &&
        url.pathname !== '/web/history' &&
        url.pathname !== '/web/file' &&
        url.pathname !== '/web/vault') ||
      !req.method
    ) {
      res.writeHead(404).end();
      return;
    }

    const token = extractBearer(req, url);
    const userId = token ? await verifyToken(token) : null;
    if (!userId) {
      sendStatus(res, 401);
      return;
    }
    const platformId = platformIdFor(userId);

    if (url.pathname === '/web/file') {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      const messageId = url.searchParams.get('message');
      const filename = url.searchParams.get('name');
      if (!messageId || !filename || !isSafeAttachmentName(messageId) || !isSafeAttachmentName(filename)) {
        sendStatus(res, 400);
        return;
      }
      const session = await resolveSession(platformId);
      if (!session) {
        sendStatus(res, 401);
        return;
      }
      const file = readOutboxFiles(session.agent_group_id, session.id, messageId, [filename])?.find(
        (candidate) => candidate.filename === filename,
      );
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      const type = fileResponseType(filename);
      res.writeHead(200, {
        'Content-Type': type.contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `${type.inline ? 'inline' : 'attachment'}; filename="${contentDispositionFilename(filename)}"`,
        ...(type.sandbox ? { 'Content-Security-Policy': 'sandbox allow-scripts' } : {}),
      });
      res.end(file.data);
      return;
    }

    if (url.pathname === '/web/vault') {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      const requestedPath = url.searchParams.get('path');
      if (!isSafeVaultPath(requestedPath)) {
        sendStatus(res, 400);
        return;
      }
      const vaultRoot = path.join(
        process.env.TWYN_BUNDLE_ROOT ?? '/srv/twyn-oracle/bundle',
        'current',
        'vaults',
        'docs',
      );
      try {
        const realRoot = fs.realpathSync(vaultRoot);
        const realFile = fs.realpathSync(path.resolve(vaultRoot, requestedPath));
        if (!isPathWithin(realRoot, realFile) || !fs.statSync(realFile).isFile()) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(fs.readFileSync(realFile));
      } catch {
        res.writeHead(404).end();
      }
      return;
    }

    if (url.pathname === '/web/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      addStream(platformId, res);
      return;
    }

    if (url.pathname === '/web/history' && req.method === 'GET') {
      const session = await resolveSession(platformId);
      if (!session) {
        sendStatus(res, 401);
        return;
      }
      const limit = historyLimit(url.searchParams.get('limit'));
      const before = historyBefore(url.searchParams.get('before'));
      const rows = await sessionHistory(
        { id: session.id, limit: limit + 1, ...(before ? { before } : {}) },
        { caller: 'host' },
      );
      const exhausted = rows.length <= limit;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ rows: rows.slice(-limit), exhausted }));
      return;
    }

    if (url.pathname === '/web/message' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        if (!payload || typeof payload !== 'object' || !('text' in payload) || typeof payload.text !== 'string') {
          sendStatus(res, 400);
          return;
        }
        const tool = 'tool' in payload ? payload.tool : undefined;
        if (tool !== undefined && (typeof tool !== 'string' || !WEB_TOOLS.has(tool))) {
          sendStatus(res, 400, 'invalid tool');
          return;
        }
        const mode = 'mode' in payload ? payload.mode : 'standard';
        if (typeof mode !== 'string' || !WEB_MODES.has(mode)) {
          sendStatus(res, 400, 'invalid mode');
          return;
        }
        const text =
          tool === undefined && mode === 'standard'
            ? payload.text
            : `[twynoracle${tool ? ` tool=${tool}` : ''}${mode !== 'standard' ? ` mode=${mode}` : ''}]\n${payload.text}`;
        await config.onInbound(platformId, null, {
          id: `web-${Date.now()}-${randomUUID()}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          isGroup: false,
          content: { text, sender: 'web', senderId: platformId },
        });
        res.writeHead(202).end();
      } catch (err) {
        log.warn('Web channel rejected inbound message', { err });
        sendStatus(res, 400);
      }
      return;
    }

    res.writeHead(405).end();
  }

  return adapter;
}

registerChannelAdapter('web', { factory: createWebAdapter, defaults: WEB_DEFAULTS });
