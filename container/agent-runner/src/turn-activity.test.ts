import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'bun:test';

import { clearActiveTurn, writeActiveTurn } from './turn-activity.js';
import { touchHeartbeat } from './heartbeat.js';

const originalHeartbeatPath = process.env.NANOCLAW_HEARTBEAT_PATH;
const temporaryDirs: string[] = [];

afterEach(() => {
  if (originalHeartbeatPath === undefined) delete process.env.NANOCLAW_HEARTBEAT_PATH;
  else process.env.NANOCLAW_HEARTBEAT_PATH = originalHeartbeatPath;
  for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('turn activity', () => {
  it('keeps active turn identity through a heartbeat-only gap and clears it at turn end', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-turn-activity-'));
    temporaryDirs.push(directory);
    process.env.NANOCLAW_HEARTBEAT_PATH = path.join(directory, '.heartbeat');

    writeActiveTurn({
      platformId: 'web:member',
      channelType: 'web',
      threadId: null,
      inReplyTo: 'turn-input',
      taskRun: false,
    });

    const activePath = path.join(directory, '.twyn-active-turn');
    expect(JSON.parse(fs.readFileSync(activePath, 'utf8'))).toEqual({
      inputId: 'turn-input',
      platformId: 'web:member',
      channelType: 'web',
      threadId: null,
      startedAtMs: expect.any(Number),
    });

    // A quiet SDK tool has no provider events, so only the ordinary heartbeat
    // may be recreated or touched. It cannot erase the active stop target.
    touchHeartbeat();
    expect(JSON.parse(fs.readFileSync(activePath, 'utf8')).inputId).toBe('turn-input');

    clearActiveTurn();
    expect(fs.existsSync(activePath)).toBe(false);
  });
});
