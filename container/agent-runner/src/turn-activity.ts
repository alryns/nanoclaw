/** TwynOracle fork: runner-to-host identity for the query that is live now. */
import fs from 'fs';
import path from 'path';

import { heartbeatPath } from './heartbeat.js';
import type { RoutingContext } from './formatter.js';

const ACTIVE_TURN_FILENAME = '.twyn-active-turn';

function activeTurnPath(): string {
  // TwynOracle fork: heartbeat may be recreated as an empty liveness file
  // during a quiet tool call. Keep the query identity beside it, not in it.
  return path.join(path.dirname(heartbeatPath()), ACTIVE_TURN_FILENAME);
}

/** Publish the routing input before polling can receive a stop command. */
export function writeActiveTurn(routing: RoutingContext): void {
  const content = JSON.stringify({
    inputId: routing.inReplyTo,
    platformId: routing.platformId,
    channelType: routing.channelType,
    threadId: routing.threadId,
    startedAtMs: Date.now(),
  });
  const target = activeTurnPath();
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
    // The runner's pure host-side test harness has no /workspace mount. A
    // deployed runner always has this directory through its session mount.
    if (!fs.existsSync(path.dirname(target))) return;
    // A bind mount that cannot atomically replace an existing file must still
    // expose a durable stop target. Let a direct-write failure fail the query
    // instead of silently losing its active-turn identity.
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  }
}

/** Clear only after the active query's event stream has fully wound down. */
export function clearActiveTurn(): void {
  try {
    fs.rmSync(activeTurnPath(), { force: true });
  } catch {
    // The mounted session directory may not exist in isolated tests.
  }
}
