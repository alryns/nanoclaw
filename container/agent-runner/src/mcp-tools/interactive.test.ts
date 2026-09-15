import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import {
  LINK_ACTION_SCHEMA,
  askUserQuestion,
  questionExpiryContent,
  questionTimeoutSeconds,
  sendCard,
  WEB_QUESTION_TIMEOUT_SECONDS,
} from './interactive.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function seedWebRouting(): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)').run(
    'web',
    'web:member-1',
    null,
  );
}

describe('send_card', () => {
  it('tells the agent when callback actions will be dropped', async () => {
    const result = await sendCard.handler({
      card: {
        title: 'Test',
        actions: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
          { label: 'Docs', url: 'https://example.com' },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('2 invalid action(s) were dropped');
    expect(result.content[0].text).toContain('ask_user_question');
    // Only renderable actions reach the payload, so the count and the row agree.
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.type).toBe('card');
    expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
  });

  it('drops a null action instead of writing something the bridge cannot read', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [null, { label: 'Docs', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
  });

  // The bridge maps any unrecognized style to the default button styling, so a
  // bad style must never cost the agent the whole button. `null` is the case
  // that matters: it is how a model most often fills an optional field.
  it.each([['chartreuse'], [null], [5], [true]])(
    'keeps an action whose style is %p, for the bridge to fall back on',
    async (style) => {
      const result = await sendCard.handler({
        card: { title: 'Test', actions: [{ label: 'Docs', url: 'https://example.com', style }] },
      });

      expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
      const content = JSON.parse(getUndeliveredMessages()[0].content);
      expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com', style }]);
    },
  );

  it('drops an action whose label is empty, the rule the schema owns', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ label: '', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([]);
  });

  it('leaves an empty or non-array actions value exactly as the bridge would', async () => {
    await sendCard.handler({ card: { title: 'Empty', actions: [] } });
    await sendCard.handler({ card: { title: 'Bogus', actions: 'nope' } });

    const [empty, bogus] = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(empty.card.actions).toEqual([]);
    expect(bogus.card.actions).toBe('nope');
  });

  it('advertises the same action schema it enforces', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { actions: { items: unknown } };
    };

    expect(cardSchema.properties.actions.items).toBe(LINK_ACTION_SCHEMA);
  });

  it('tells the agent when a URL action has no label', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    expect(result.content[0].text).toContain('web link (http or https)');
  });

  // A model asked for an approval card cannot make a callback button, so it
  // fakes one with a placeholder href. Dropping it points the agent at
  // ask_user_question instead of posting two dead links. Non-web schemes go the
  // same way: the agent does not pick the channel, and mailto:/tel: are not
  // link buttons on Discord or Telegram.
  it.each([
    ['#'],
    ['/docs'],
    ['example.com'],
    ['   '],
    ['localhost:3000'],
    ['mailto:someone@example.com'],
    ['tel:+34600000000'],
    ['javascript:alert(1)'],
    // A scheme with no host satisfies the drop message read literally, so it is
    // the cheapest wrong retry; whitespace would break out of '[label](url)'.
    ['https://'],
    ['https:///nohost'],
    ['https://example.com '],
    ['https://example.com\njavascript:alert(1)'],
  ])('drops a link action whose url is %p', async (url) => {
    const result = await sendCard.handler({
      card: { title: 'Test Approval Card', actions: [{ label: 'Approve', url }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([]);
  });

  // The scheme is case-insensitive per RFC 3986 §3.1, and an agent quoting a
  // url out of a document may well quote it uppercase.
  it.each([['https://example.com'], ['http://localhost:3000/x'], ['HTTPS://EXAMPLE.COM']])(
    'keeps a link action whose url is %p',
    async (url) => {
      const result = await sendCard.handler({ card: { title: 'Test', actions: [{ label: 'Open', url }] } });

      expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
      const content = JSON.parse(getUndeliveredMessages()[0].content);
      expect(content.card.actions).toEqual([{ label: 'Open', url }]);
    },
  );

  it('states the url rule in the schema description the agent reads', () => {
    const url = LINK_ACTION_SCHEMA.properties.url as { description: string };

    expect(url.description).toContain('http or https');
  });

  it('constrains children to text instead of promising nested action blocks', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { children: { description: string; items: { anyOf: Array<Record<string, unknown>> } } };
    };

    expect(cardSchema.properties.children.description).toContain('Nested action blocks are unsupported');
    expect(cardSchema.properties.children.items.anyOf).toHaveLength(2);
  });

  it('stays quiet when every action has a url', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ label: 'Docs', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
  });

  it('stays quiet for display-only cards', async () => {
    const result = await sendCard.handler({ card: { title: 'Test', description: 'No actions' } });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
  });
});

test('web question timeout cap is a single 120-second constant', () => {
  expect(WEB_QUESTION_TIMEOUT_SECONDS).toBe(120);
  expect(questionTimeoutSeconds('web', 300)).toBe(120);
  expect(questionTimeoutSeconds('web', 20)).toBe(20);
  expect(questionTimeoutSeconds('slack', 300)).toBe(300);
  expect(questionExpiryContent('web', 'q-1')).toEqual({ type: 'ask_question_expired', questionId: 'q-1' });
  expect(questionExpiryContent('slack', 'q-1')).toBeUndefined();
});

test('writes an expiry record for every timed out web question', async () => {
  seedWebRouting();

  const result = await askUserQuestion.handler({
    title: 'Choose',
    question: 'Which option?',
    options: ['One'],
    // A short request keeps the test fast. Web still uses the same timeout
    // path as its 120-second default and must always write the expiry record.
    timeout: 0.001,
  });

  expect(result.isError).toBe(true);
  const messages = getUndeliveredMessages().map((message) => JSON.parse(message.content));
  expect(messages).toHaveLength(2);
  expect(messages[1]).toEqual({ type: 'ask_question_expired', questionId: messages[0].questionId });
});

test('ends a pending question wait when the host stop command arrives', async () => {
  seedWebRouting();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'system', ?, 'pending', ?)`,
    )
    .run(
      'stop-command',
      new Date().toISOString(),
      JSON.stringify({ type: 'twyn_stop_turn', noticeId: 'stopped-notice' }),
    );

  const result = await askUserQuestion.handler({
    title: 'Choose',
    question: 'Which option?',
    options: ['One'],
  });

  expect(result).toEqual({
    content: [{ type: 'text', text: 'Error: Question stopped' }],
    isError: true,
  });
  expect(getUndeliveredMessages()).toHaveLength(1);
});
