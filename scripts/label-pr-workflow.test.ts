/**
 * Fixture tests for the PR labeling decision logic (CI-04 acceptance
 * criteria). The logic ships inline in .github/workflows/label-pr.yml (the
 * pull_request_target workflow is metadata-only and never checks out the
 * repo, so it cannot read a script file at runtime); these tests extract the
 * exact code between the NANOCLAW-LABEL-LOGIC markers from the workflow file
 * and evaluate it, so the tested function and the shipped function cannot
 * drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface LabelDecision {
  add: string[];
  remove: string[];
  coreTeam: boolean;
}

type ComputeLabels = (args: { body?: string | null; title?: string | null; author?: string | null }) => LabelDecision;

function extractComputeLabels(): ComputeLabels {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'label-pr.yml'),
    'utf8',
  );
  const start = workflow.indexOf('NANOCLAW-LABEL-LOGIC-START');
  const end = workflow.indexOf('NANOCLAW-LABEL-LOGIC-END');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('NANOCLAW-LABEL-LOGIC markers not found in label-pr.yml');
  }
  const block = workflow.slice(start, end);
  // Strip the YAML block-scalar indentation so the code parses standalone.
  const code = block
    .split('\n')
    .slice(1) // drop the START marker line itself
    .map((line) => line.replace(/^ {12}/, ''))
    .join('\n');
  return new Function(`${code}\nreturn computeLabels;`)() as ComputeLabels;
}

const computeLabels = extractComputeLabels();

const V2 = '<!-- nanoclaw-pr-template:v2 -->\n';
const v2Body = (kinds: string[], opts: { skill?: boolean } = {}) =>
  V2 +
  '## Change kind\n' +
  ['kind/bug', 'kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening']
    .map((k) => `- [${kinds.includes(k) ? 'x' : ' '}] \`${k}\``)
    .join('\n') +
  '\n## Skill delivery\n' +
  `- [${opts.skill ? ' ' : 'x'}] Not a skill\n` +
  `- [${opts.skill ? 'x' : ' '}] Skill: apply/remove footprint and fresh-clone verification are described above\n`;

const FORK_AUTHOR = 'drive-by-contributor';

describe('v2 bodies (nanoclaw-pr-template:v2 marker)', () => {
  it('exactly one checked kind: adds it, its legacy twin, and removes the other managed kinds', () => {
    const res = computeLabels({ body: v2Body(['kind/bug']), title: 'anything', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/bug');
    expect(res.add).toContain('PR: Fix');
    expect(res.add).toContain('follows-guidelines');
    expect(res.remove).toEqual(
      expect.arrayContaining(['kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening']),
    );
    expect(res.remove).not.toContain('kind/bug');
  });

  it('kind/hardening has no legacy PR:* twin', () => {
    const res = computeLabels({ body: v2Body(['kind/hardening']), title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/hardening');
    expect(res.add.filter((l) => l.startsWith('PR: '))).toEqual([]);
  });

  it('zero checked kinds: falls back to the conventional-commit title prefix', () => {
    const res = computeLabels({ body: v2Body([]), title: 'fix(host-sweep): make the ceiling configurable', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/bug');
    expect(res.add).toContain('PR: Fix');
    expect(res.remove).toContain('kind/feature');
  });

  it('multiple checked kinds: title prefix decides, checkboxes are ignored', () => {
    const res = computeLabels({ body: v2Body(['kind/bug', 'kind/feature']), title: 'docs: fix a typo', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/documentation');
    expect(res.add).not.toContain('kind/bug');
    expect(res.add).not.toContain('kind/feature');
  });

  it('still ambiguous (no boxes, unmappable title): applies no kind and removes nothing', () => {
    const res = computeLabels({ body: v2Body([]), title: 'Update stuff', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('kind/'))).toEqual([]);
    expect(res.remove).toEqual([]);
  });

  it('edited selection reconciles: the newly checked kind lands, every other managed kind is removed', () => {
    // Simulates the second run after an author unchecks bug and checks cleanup.
    const res = computeLabels({ body: v2Body(['kind/cleanup']), title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/cleanup');
    expect(res.add).toContain('PR: Refactor');
    expect(res.remove).toContain('kind/bug');
  });

  it('checkbox case: [X] counts as checked', () => {
    const body = V2 + '- [X] `kind/feature`\n';
    const res = computeLabels({ body, title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/feature');
  });

  it('skill delivery checkbox adds delivery/skill and the legacy PR: Skill', () => {
    const res = computeLabels({ body: v2Body(['kind/bug'], { skill: true }), title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('delivery/skill');
    expect(res.add).toContain('PR: Skill');
    expect(res.add).toContain('kind/bug');
  });

  it('AI-assistance checkboxes carry no label semantics and do not confuse the kind parser', () => {
    const ai =
      '## AI assistance\n' +
      '- [ ] No AI assistance\n' +
      '- [ ] AI-assisted: a person wrote this with AI help\n' +
      '- [x] Agent-authored: an AI agent wrote this\n' +
      '- [x] A human has reviewed this PR and stands behind every change\n';
    const withKind = computeLabels({ body: v2Body(['kind/bug']) + ai, title: 'x', author: FORK_AUTHOR });
    expect(withKind.add).toContain('kind/bug');
    expect(withKind.add.filter((l) => l.startsWith('kind/'))).toEqual(['kind/bug']);
    expect(withKind.add).not.toContain('delivery/skill');

    // No kind box checked: the AI section must not register as a kind or a
    // skill, and the title fallback still decides.
    const fallback = computeLabels({ body: v2Body([]) + ai, title: 'docs: clarify setup', author: FORK_AUTHOR });
    expect(fallback.add).toContain('kind/documentation');
    expect(fallback.add).not.toContain('PR: Skill');
  });

  it('chore and refactor title prefixes both map to kind/cleanup', () => {
    for (const title of ['chore(deps): bump x', 'refactor: flatten y']) {
      const res = computeLabels({ body: v2Body([]), title, author: FORK_AUTHOR });
      expect(res.add).toContain('kind/cleanup');
    }
  });

  it('never emits a label outside the fixed vocabularies', () => {
    const KNOWN = new Set([
      'kind/bug', 'kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening',
      'PR: Fix', 'PR: Feature', 'PR: Docs', 'PR: Refactor', 'PR: Skill',
      'delivery/skill', 'follows-guidelines', 'core-team',
    ]);
    for (const body of [v2Body(['kind/bug'], { skill: true }), v2Body([]), v2Body(['kind/hardening'])]) {
      for (const label of computeLabels({ body, title: 'feat!: breaking', author: 'glifocat' }).add) {
        expect(KNOWN.has(label), label).toBe(true);
      }
    }
  });
});

describe('v1 bodies (frozen pre-v2 behavior)', () => {
  it('checkbox substring adds both vocabularies, add-only', () => {
    const res = computeLabels({ body: '<!-- contributing-guide: v1 -->\n- [x] **Fix** - bug fix', title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('PR: Fix');
    expect(res.add).toContain('kind/bug');
    expect(res.add).toContain('follows-guidelines');
    expect(res.remove).toEqual([]);
  });

  it('feature skill emits the full four-label set', () => {
    const res = computeLabels({ body: '- [x] **Feature skill** - adds a channel', title: 'x', author: FORK_AUTHOR });
    expect(res.add).toEqual(expect.arrayContaining(['PR: Skill', 'PR: Feature', 'kind/feature', 'delivery/skill']));
  });

  it('first checked box wins, exactly as before', () => {
    const res = computeLabels({
      body: '- [x] **Fix** - bug fix\n- [x] **Documentation** - docs only',
      title: 'x',
      author: FORK_AUTHOR,
    });
    expect(res.add).toContain('PR: Fix');
    expect(res.add).not.toContain('PR: Docs');
  });

  it('v1 matching stays case-sensitive: [X] is not recognized', () => {
    const res = computeLabels({ body: '- [X] **Fix** - bug fix', title: 'x', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('PR: '))).toEqual([]);
  });

  it('missing body: no labels, no removals, no crash', () => {
    const res = computeLabels({ body: null, title: null, author: FORK_AUTHOR });
    expect(res.add).toEqual([]);
    expect(res.remove).toEqual([]);
  });
});

describe('author handling (both paths)', () => {
  it('fork-authored PR gets no core-team label', () => {
    const res = computeLabels({ body: v2Body(['kind/bug']), title: 'x', author: FORK_AUTHOR });
    expect(res.add).not.toContain('core-team');
    expect(res.coreTeam).toBe(false);
  });

  it('core-team roster match is case-insensitive on the login', () => {
    const res = computeLabels({ body: v2Body(['kind/bug']), title: 'x', author: 'Glifocat' });
    expect(res.add).toContain('core-team');
    expect(res.coreTeam).toBe(true);
  });
});
