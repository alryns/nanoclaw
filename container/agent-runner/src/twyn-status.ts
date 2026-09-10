import fs from 'fs';
import path from 'path';

import { heartbeatPath } from './heartbeat.js';

export const STATUS_FILENAME = '.status';

const MAX_STATUS_CHARS = 80;
const DRAWING_EXTENSIONS = new Set(['.svg', '.html', '.mmd', '.mermaid', '.drawio']);
const READING_TOOLS = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch']);
const READING_MCP_TERMS = ['knowledge', 'search', 'query', 'read', 'fetch', 'list'];

export type ToolPhase = 'Reading sources' | 'Drawing' | 'Sending the file' | 'Working on it';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | null {
  return isRecord(value) && typeof value[field] === 'string' ? value[field] : null;
}

function drawingPath(input: unknown): string | null {
  return stringField(input, 'file_path') ?? stringField(input, 'path');
}

function isDrawingPath(input: unknown): boolean {
  const filePath = drawingPath(input);
  return filePath !== null && DRAWING_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isDrawingCommand(input: unknown): boolean {
  const command = stringField(input, 'command')?.toLowerCase();
  return (
    command?.includes('verify-geometry') === true ||
    command?.includes('platform-send-gate') === true ||
    command?.includes('mermaid') === true
  );
}

/** Return the member-facing phase for an SDK tool use, if this tool has one. */
export function phaseForToolUse(toolName: string, input: unknown): ToolPhase | null {
  const name = toolName.toLowerCase();
  if (name.includes('send_file')) return 'Sending the file';
  if (name.startsWith('mcp__') && READING_MCP_TERMS.some((term) => name.includes(term))) return 'Reading sources';
  if (READING_TOOLS.has(name)) return 'Reading sources';
  if (name === 'write' || name === 'edit') return isDrawingPath(input) ? 'Drawing' : 'Working on it';
  if (name === 'bash') return isDrawingCommand(input) ? 'Drawing' : 'Working on it';
  return null;
}

/** The status file lives beside the host-observed heartbeat, including test overrides. */
export function statusFilePath(): string {
  return path.join(path.dirname(heartbeatPath()), STATUS_FILENAME);
}

function oneLineStatus(status: string): string {
  return status
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_STATUS_CHARS);
}

/** Atomically publish a changed status without perturbing the file for duplicate events. */
export function writeTurnStatus(status: string): void {
  const text = oneLineStatus(status);
  if (!text) {
    clearTurnStatus();
    return;
  }

  const target = statusFilePath();
  const content = `${text}\n`;
  try {
    if (fs.readFileSync(target, 'utf8') === content) return;
  } catch {
    // A missing status is the normal first write of a turn.
  }

  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file was never created, or rename already consumed it.
    }
  }
}

/** Remove the last turn's status. Missing files are expected. */
export function clearTurnStatus(): void {
  try {
    fs.unlinkSync(statusFilePath());
  } catch {
    // The status may already have been cleared after a result event.
  }
}

function compactedTokenCount(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return 'Tidying memory';
  if (tokens < 1_000) return `Tidying memory (${Math.round(tokens)} tokens)`;
  if (tokens < 1_000_000) return `Tidying memory (${Math.round(tokens / 1_000)}k tokens)`;
  return `Tidying memory (${(Math.round((tokens / 1_000_000) * 10) / 10).toString()}m tokens)`;
}

function compactBoundaryTokens(message: Record<string, unknown>): number | null {
  const metadata = message.compact_metadata;
  return isRecord(metadata) && typeof metadata.pre_tokens === 'number' ? metadata.pre_tokens : null;
}

/**
 * Observe raw Claude SDK messages. Tool results are user messages, so the
 * next assistant text after any tool use is the start of answer drafting.
 */
export function createTwynStatusObserver(): { observe(message: unknown): void } {
  let toolUseSinceText = false;
  // A container killed mid-turn (host sweep, docker kill) never reaches the result or the
  // finally block, so a stale phase would sit in the shared session directory and the host
  // probe would show it for the next turn until its first tool use. Each query starts clean.
  clearTurnStatus();

  return {
    observe(message: unknown): void {
      if (!isRecord(message)) return;
      const type = stringField(message, 'type');
      if (type === 'system' && stringField(message, 'subtype') === 'compact_boundary') {
        writeTurnStatus(compactedTokenCount(compactBoundaryTokens(message)));
        return;
      }
      if (type === 'result') {
        clearTurnStatus();
        toolUseSinceText = false;
        return;
      }
      if (type !== 'assistant' || !isRecord(message.message) || !Array.isArray(message.message.content)) return;

      for (const block of message.message.content) {
        if (!isRecord(block)) continue;
        if (stringField(block, 'type') === 'tool_use') {
          const toolName = stringField(block, 'name');
          if (toolName) {
            const phase = phaseForToolUse(toolName, block.input);
            if (phase) writeTurnStatus(phase);
          }
          toolUseSinceText = true;
        } else if (stringField(block, 'type') === 'text' && stringField(block, 'text') && toolUseSinceText) {
          writeTurnStatus('Drafting the answer');
          toolUseSinceText = false;
        }
      }
    },
  };
}
