import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createTwynStatusObserver, phaseForToolUse, statusFilePath, writeTurnStatus } from './twyn-status.js';

let tmp: string;
let previousHeartbeatPath: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twyn-status-'));
  previousHeartbeatPath = process.env.NANOCLAW_HEARTBEAT_PATH;
  process.env.NANOCLAW_HEARTBEAT_PATH = path.join(tmp, '.heartbeat');
});

afterEach(() => {
  if (previousHeartbeatPath === undefined) delete process.env.NANOCLAW_HEARTBEAT_PATH;
  else process.env.NANOCLAW_HEARTBEAT_PATH = previousHeartbeatPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Twyn runner status phases', () => {
  it('maps supported tool uses to the member-facing vocabulary', () => {
    expect(phaseForToolUse('Read', {})).toBe('Reading sources');
    expect(phaseForToolUse('Glob', {})).toBe('Reading sources');
    expect(phaseForToolUse('Grep', {})).toBe('Reading sources');
    expect(phaseForToolUse('WebFetch', {})).toBe('Reading sources');
    expect(phaseForToolUse('WebSearch', {})).toBe('Reading sources');
    for (const name of [
      'mcp__knowledge__lookup',
      'mcp__docs__search',
      'mcp__docs__query',
      'mcp__docs__read',
      'mcp__docs__fetch',
      'mcp__docs__list',
    ]) {
      expect(phaseForToolUse(name, {})).toBe('Reading sources');
    }
    expect(phaseForToolUse('Write', { file_path: '/workspace/diagram.svg' })).toBe('Drawing');
    for (const extension of ['.html', '.mmd', '.mermaid', '.drawio']) {
      expect(phaseForToolUse('Edit', { path: `/workspace/flow${extension}` })).toBe('Drawing');
    }
    expect(phaseForToolUse('Bash', { command: 'verify-geometry diagram.svg' })).toBe('Drawing');
    expect(phaseForToolUse('Bash', { command: 'platform-send-gate diagram.svg' })).toBe('Drawing');
    expect(phaseForToolUse('Bash', { command: 'render mermaid flowchart' })).toBe('Drawing');
    expect(phaseForToolUse('mcp__nanoclaw__send_file', {})).toBe('Sending the file');
    expect(phaseForToolUse('Bash', { command: 'npm run test' })).toBe('Working on it');
    expect(phaseForToolUse('Write', { file_path: '/workspace/notes.md' })).toBe('Working on it');
    expect(phaseForToolUse('Task', {})).toBeNull();
  });

  it('writes changed statuses atomically and does not replace an unchanged file', () => {
    writeTurnStatus('Reading sources');
    const target = statusFilePath();
    const first = fs.statSync(target);

    writeTurnStatus('Reading sources');
    expect(fs.statSync(target).ino).toBe(first.ino);

    writeTurnStatus('Drawing');
    expect(fs.statSync(target).ino).not.toBe(first.ino);
    expect(fs.readFileSync(target, 'utf8')).toBe('Drawing\n');
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.startsWith('.status.tmp-'))).toBe(false);
  });

  it('starts a query with any stale status from a killed turn removed', () => {
    writeTurnStatus('Drawing');
    expect(fs.existsSync(statusFilePath())).toBe(true);
    createTwynStatusObserver();
    expect(fs.existsSync(statusFilePath())).toBe(false);
  });

  it('publishes compaction and drafting statuses, then clears them at the result boundary', () => {
    const observer = createTwynStatusObserver();
    observer.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 131_000 } });
    expect(fs.readFileSync(statusFilePath(), 'utf8')).toBe(
      'Summarising the chat so far, this takes a minute (131k tokens)\n',
    );

    observer.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
    expect(fs.readFileSync(statusFilePath(), 'utf8')).toBe('Reading sources\n');

    observer.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is the answer.' }] } });
    expect(fs.readFileSync(statusFilePath(), 'utf8')).toBe('Drafting the answer\n');

    observer.observe({ type: 'result' });
    expect(fs.existsSync(statusFilePath())).toBe(false);
  });
});
