/** TwynOracle fork: parse the host's durable web stop command. */
import type { MessageInRow } from './db/messages-in.js';

export interface StopRequest {
  noticeId: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  /** TwynOracle fork: cold-start inputs to complete without querying. */
  cancelInputIds: string[];
  /** The host wrote this notice before the runner had started. */
  noticeAlreadyWritten: boolean;
}

export function stopRequest(message: Pick<MessageInRow, 'kind' | 'content'>): StopRequest | null {
  if (message.kind !== 'system') return null;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (value.type !== 'twyn_stop_turn' || typeof value.noticeId !== 'string') return null;
    const nullableText = (entry: unknown): string | null => (typeof entry === 'string' ? entry : null);
    const cancelInputIds = Array.isArray(value.cancelInputIds)
      ? [
          ...new Set(
            value.cancelInputIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
          ),
        ]
      : [];
    return {
      noticeId: value.noticeId,
      platformId: nullableText(value.platformId),
      channelType: nullableText(value.channelType),
      threadId: nullableText(value.threadId),
      cancelInputIds,
      noticeAlreadyWritten: value.noticeAlreadyWritten === true,
    };
  } catch {
    return null;
  }
}
