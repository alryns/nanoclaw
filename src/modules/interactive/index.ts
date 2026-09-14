/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the pending_questions
 * row, write the response into the session's inbound.db, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { getPendingQuestion, getSession } from '../../db/sessions.js';
// TwynOracle fork: retain selected labels for web card history.
import { markWebQuestionAnswered } from '../../channels/web-cards.js';
import { requestWake } from '../../request-wake.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

// TwynOracle fork: exported for the atomic web-card claim regression test.
export async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!(await hasTable(getDb(), 'pending_questions'))) return false;

  // TwynOracle fork: claim under the central DB transaction, so the first click wins.
  const pq = await getDb().transaction(async () => {
    const pending = await getPendingQuestion(payload.questionId);
    if (pending) {
      await getDb().run('DELETE FROM pending_questions WHERE question_id = ?', payload.questionId);
      // TwynOracle fork: selected-card state must commit with the claim, before runner I/O.
      await markWebQuestionAnswered(payload.questionId, payload.value);
    }
    return pending;
  });
  if (!pq) return false;

  const session = await getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    return true; // claimed — we owned this questionId even though the session is gone
  }

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      selectedOption: payload.value,
      userId: payload.userId ?? '',
    }),
  });
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });

  await requestWake(session, 'interactive');
  return true;
}

registerResponseHandler(handleInteractiveResponse);
