/** TwynOracle fork: durable state and expiry for web-only interactive cards. */
import { getDb } from '../db/connection.js';
import { registerMigration, type ModuleMigration } from '../db/migrations/index.js';

/** TwynOracle fork: self-register before index.ts calls runMigrations(). */
export const webQuestionCardsMigration: ModuleMigration = {
  version: 1,
  name: 'module:twyn-web:question-cards',
  async up(db) {
    await db.exec(`
      CREATE TABLE web_question_cards (
        question_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        selected_label TEXT
      );
      CREATE INDEX idx_web_question_cards_expiry ON web_question_cards(state, expires_at);
      CREATE INDEX idx_web_question_cards_session ON web_question_cards(session_id);
    `);
  },
};

registerMigration(webQuestionCardsMigration);

export const WEB_QUESTION_TIMEOUT_MS = 120_000;
export const WEB_QUESTION_DELIVERY_GRACE_MS = 10_000;
// The runner starts its 120-second clock before host delivery. Close the host
// card early so every accepted answer can still reach its polling runner.
export const WEB_CARD_EXPIRY_MS = WEB_QUESTION_TIMEOUT_MS - WEB_QUESTION_DELIVERY_GRACE_MS;

type Option = { label: string; selectedLabel?: string; value?: string };

function options(value: unknown): Option[] | null {
  if (!Array.isArray(value) || !value.every((option) => option && typeof option === 'object')) return null;
  const parsed = value as Option[];
  return parsed.every((option) => typeof option.label === 'string' && option.label.length > 0) ? parsed : null;
}

function questionId(content: Record<string, unknown>): string | null {
  return typeof content.questionId === 'string' && content.questionId.length > 0 ? content.questionId : null;
}

export function isWebCardContent(content: unknown): boolean {
  return (
    !!content &&
    typeof content === 'object' &&
    ['ask_question', 'ask_question_expired', 'card'].includes((content as Record<string, unknown>).type as string)
  );
}

export async function recordWebCard(sessionId: string, platformId: string, content: unknown): Promise<void> {
  if (!content || typeof content !== 'object') return;
  const card = content as Record<string, unknown>;
  if (card.type === 'ask_question_expired') {
    const expiredId = questionId(card);
    if (expiredId) await expireWebQuestion(expiredId);
    return;
  }
  const id = card.type === 'ask_question' ? questionId(card) : null;
  const cardOptions = options(card.options);
  if (!id || !cardOptions || typeof card.title !== 'string' || typeof card.question !== 'string') return;
  const createdAt = new Date().toISOString();
  await getDb().run(
    `INSERT INTO web_question_cards
       (question_id, session_id, platform_id, title, question, options_json, created_at, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(question_id) DO NOTHING`,
    id,
    sessionId,
    platformId,
    card.title,
    card.question,
    JSON.stringify(cardOptions),
    createdAt,
    new Date(Date.now() + WEB_CARD_EXPIRY_MS).toISOString(),
  );
}

export async function expireWebQuestions(sessionId?: string): Promise<string[]> {
  const now = new Date().toISOString();
  return getDb().transaction(async () => {
    const expired = await getDb().all<{ question_id: string }>(
      `SELECT question_id FROM web_question_cards
       WHERE state = 'pending' AND expires_at <= ?${sessionId ? ' AND session_id = ?' : ''}`,
      ...(sessionId ? [now, sessionId] : [now]),
    );
    if (!expired.length) return [];
    await getDb().run(
      `UPDATE web_question_cards SET state = 'timed_out' WHERE question_id IN (${expired.map(() => '?').join(', ')})`,
      ...expired.map((row) => row.question_id),
    );
    await getDb().run(
      `DELETE FROM pending_questions WHERE question_id IN (${expired.map(() => '?').join(', ')})`,
      ...expired.map((row) => row.question_id),
    );
    return expired.map((row) => row.question_id);
  });
}

export async function expireWebQuestion(questionIdValue: string): Promise<void> {
  await getDb().transaction(async () => {
    await getDb().run(
      "UPDATE web_question_cards SET state = 'timed_out' WHERE question_id = ? AND state = 'pending'",
      questionIdValue,
    );
    await getDb().run('DELETE FROM pending_questions WHERE question_id = ?', questionIdValue);
  });
}

/** TwynOracle fork: a stopped turn can no longer consume a card response. */
export async function stopWebQuestions(sessionId: string): Promise<string[]> {
  return getDb().transaction(async () => {
    const pending = await getDb().all<{ question_id: string }>(
      "SELECT question_id FROM web_question_cards WHERE session_id = ? AND state = 'pending'",
      sessionId,
    );
    if (pending.length === 0) return [];
    const ids = pending.map((row) => row.question_id);
    await getDb().run(
      `UPDATE web_question_cards SET state = 'stopped' WHERE question_id IN (${ids.map(() => '?').join(', ')})`,
      ...ids,
    );
    await getDb().run(`DELETE FROM pending_questions WHERE question_id IN (${ids.map(() => '?').join(', ')})`, ...ids);
    return ids;
  });
}

export async function canAnswerWebQuestion(
  sessionId: string,
  platformId: string,
  questionIdValue: string,
  value: string,
): Promise<boolean> {
  await expireWebQuestions(sessionId);
  const row = await getDb().get<{ options_json: string }>(
    `SELECT options_json FROM web_question_cards
     WHERE question_id = ? AND session_id = ? AND platform_id = ? AND state = 'pending'`,
    questionIdValue,
    sessionId,
    platformId,
  );
  if (!row) return false;
  const cardOptions = options(JSON.parse(row.options_json));
  return cardOptions?.some((option) => (option.value ?? option.label) === value) ?? false;
}

export async function markWebQuestionAnswered(questionIdValue: string, value: string): Promise<void> {
  const row = await getDb().get<{ options_json: string }>(
    'SELECT options_json FROM web_question_cards WHERE question_id = ?',
    questionIdValue,
  );
  if (!row) return;
  const option = options(JSON.parse(row.options_json))?.find((item) => (item.value ?? item.label) === value);
  if (!option) return;
  await getDb().run(
    `UPDATE web_question_cards SET state = 'answered', selected_label = ? WHERE question_id = ? AND state = 'pending'`,
    option.selectedLabel ?? option.label,
    questionIdValue,
  );
}

export async function addWebCardStates<T extends { card?: unknown }>(rows: T[]): Promise<T[]> {
  const ids = rows
    .map((row) => row.card)
    .filter(
      (card): card is Record<string, unknown> =>
        !!card && typeof card === 'object' && (card as Record<string, unknown>).type === 'question',
    )
    .map((card) => card.questionId)
    .filter((id): id is string => typeof id === 'string');
  if (!ids.length) return rows;
  const states = await getDb().all<{ question_id: string; state: string; selected_label: string | null }>(
    `SELECT question_id, state, selected_label FROM web_question_cards WHERE question_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  );
  const byId = new Map(states.map((state) => [state.question_id, state]));
  return rows.map((row) => {
    if (!row.card || typeof row.card !== 'object') return row;
    const card = row.card as Record<string, unknown>;
    if (card.type !== 'question' || typeof card.questionId !== 'string') return row;
    const state = byId.get(card.questionId);
    return state
      ? { ...row, card: { ...card, state: state.state, selectedLabel: state.selected_label ?? undefined } }
      : row;
  });
}
