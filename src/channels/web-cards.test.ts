/** TwynOracle fork: web question-card persistence and expiry. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, getDb, initSqliteTestDb } from '../db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../db/migrations/index.js';
import { createPendingQuestion, createSession, getPendingQuestion } from '../db/sessions.js';
import {
  addWebCardStates,
  canAnswerWebQuestion,
  expireWebQuestion,
  expireWebQuestions,
  markWebQuestionAnswered,
  recordWebCard,
  stopWebQuestions,
  WEB_CARD_EXPIRY_MS,
  WEB_QUESTION_TIMEOUT_MS,
} from './web-cards.js';

const card = {
  type: 'ask_question',
  questionId: 'q-1',
  title: 'Choose',
  question: 'Which?',
  options: [{ label: 'One', selectedLabel: 'First choice', value: 'one' }],
};

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now });
  await createSession({
    id: 'session-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('web question cards', () => {
  it('registers and idempotently applies its module migration on a fresh DB', async () => {
    expect(getRegisteredMigrations()).toContainEqual(
      expect.objectContaining({ name: 'module:twyn-web:question-cards' }),
    );
    expect(await getDb().hasTable('web_question_cards')).toBe(true);

    await runMigrations(getDb());
    expect(
      await getDb().all<{ name: string }>(
        "SELECT name FROM schema_version WHERE name = 'module:twyn-web:question-cards'",
      ),
    ).toEqual([{ name: 'module:twyn-web:question-cards' }]);
  });

  it('persists the selected label for reload history and validates the exact option', async () => {
    await recordWebCard('session-1', 'web:member-1', card);
    expect(await canAnswerWebQuestion('session-1', 'web:member-1', 'q-1', 'one')).toBe(true);
    expect(await canAnswerWebQuestion('session-1', 'web:member-1', 'q-1', 'forged')).toBe(false);
    expect(await canAnswerWebQuestion('session-1', 'web:member-2', 'q-1', 'one')).toBe(false);

    await markWebQuestionAnswered('q-1', 'one');
    await expect(addWebCardStates([{ card: { type: 'question', questionId: 'q-1' } }])).resolves.toEqual([
      { card: { type: 'question', questionId: 'q-1', state: 'answered', selectedLabel: 'First choice' } },
    ]);
  });

  it('sets the host deadline ten seconds before the runner timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'));

    await recordWebCard('session-1', 'web:member-1', card);

    const stored = await getDb().get<{ expires_at: string }>(
      "SELECT expires_at FROM web_question_cards WHERE question_id = 'q-1'",
    );
    expect(WEB_CARD_EXPIRY_MS).toBe(WEB_QUESTION_TIMEOUT_MS - 10_000);
    expect(stored?.expires_at).toBe('2026-09-14T12:01:50.000Z');
  });

  it('never lets an expiry sweep override an answered card', async () => {
    await recordWebCard('session-1', 'web:member-1', card);
    await markWebQuestionAnswered('q-1', 'one');
    await getDb().run(
      "UPDATE web_question_cards SET expires_at = '2000-01-01T00:00:00.000Z' WHERE question_id = 'q-1'",
    );

    await expireWebQuestions('session-1');
    await expireWebQuestion('q-1');

    await expect(addWebCardStates([{ card: { type: 'question', questionId: 'q-1' } }])).resolves.toEqual([
      { card: { type: 'question', questionId: 'q-1', state: 'answered', selectedLabel: 'First choice' } },
    ]);
  });

  it('times out expired cards and removes their pending response row', async () => {
    await recordWebCard('session-1', 'web:member-1', card);
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'session-1',
      message_out_id: 'out-1',
      platform_id: 'web:member-1',
      channel_type: 'web',
      thread_id: null,
      title: 'Choose',
      options: card.options,
      created_at: new Date().toISOString(),
    });
    await getDb().run(
      "UPDATE web_question_cards SET expires_at = '2000-01-01T00:00:00.000Z' WHERE question_id = 'q-1'",
    );

    await expireWebQuestions('session-1');

    expect(await getPendingQuestion('q-1')).toBeUndefined();
    await expect(addWebCardStates([{ card: { type: 'question', questionId: 'q-1' } }])).resolves.toEqual([
      { card: { type: 'question', questionId: 'q-1', state: 'timed_out', selectedLabel: undefined } },
    ]);
  });

  it('ends pending cards when their turn is stopped', async () => {
    await recordWebCard('session-1', 'web:member-1', card);
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'session-1',
      message_out_id: 'out-1',
      platform_id: 'web:member-1',
      channel_type: 'web',
      thread_id: null,
      title: 'Choose',
      options: card.options,
      created_at: new Date().toISOString(),
    });

    await expect(stopWebQuestions('session-1')).resolves.toEqual(['q-1']);
    expect(await getPendingQuestion('q-1')).toBeUndefined();
    await expect(addWebCardStates([{ card: { type: 'question', questionId: 'q-1' } }])).resolves.toEqual([
      { card: { type: 'question', questionId: 'q-1', state: 'stopped', selectedLabel: undefined } },
    ]);
  });
});
