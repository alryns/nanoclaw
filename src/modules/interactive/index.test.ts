/** TwynOracle fork: interactive web-card claim atomicity. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingQuestion, createSession, getPendingQuestion } from '../../db/sessions.js';
import { addWebCardStates, recordWebCard } from '../../channels/web-cards.js';

const writeSessionMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const requestWake = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../session-manager.js', () => ({ writeSessionMessage }));
vi.mock('../../request-wake.js', () => ({ requestWake }));

import { handleInteractiveResponse } from './index.js';

const card = {
  type: 'ask_question',
  questionId: 'q-1',
  title: 'Choose',
  question: 'Which?',
  options: [{ label: 'One', selectedLabel: 'First choice', value: 'one' }],
};

beforeEach(async () => {
  const db = await initTestDb();
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
  await recordWebCard('session-1', 'web:member-1', card);
  await createPendingQuestion({
    question_id: 'q-1',
    session_id: 'session-1',
    message_out_id: 'out-1',
    platform_id: 'web:member-1',
    channel_type: 'web',
    thread_id: null,
    title: card.title,
    options: card.options,
    created_at: now,
  });
  writeSessionMessage.mockClear();
  requestWake.mockClear();
});

afterEach(closeDb);

it('commits the pending-question claim and answered card state together', async () => {
  await expect(
    handleInteractiveResponse({
      questionId: 'q-1',
      value: 'one',
      userId: 'member-1',
      channelType: 'web',
      platformId: 'web:member-1',
      threadId: null,
    }),
  ).resolves.toBe(true);

  expect(await getPendingQuestion('q-1')).toBeUndefined();
  await expect(addWebCardStates([{ card: { type: 'question', questionId: 'q-1' } }])).resolves.toEqual([
    { card: { type: 'question', questionId: 'q-1', state: 'answered', selectedLabel: 'First choice' } },
  ]);
});

it('rolls back the claim when the answered-card update fails', async () => {
  await getDb().exec('DROP TABLE web_question_cards');

  await expect(
    handleInteractiveResponse({
      questionId: 'q-1',
      value: 'one',
      userId: 'member-1',
      channelType: 'web',
      platformId: 'web:member-1',
      threadId: null,
    }),
  ).rejects.toThrow(/web_question_cards/);

  expect(await getPendingQuestion('q-1')).toBeDefined();
  expect(writeSessionMessage).not.toHaveBeenCalled();
});
