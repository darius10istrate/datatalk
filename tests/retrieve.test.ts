import { describe, expect, it } from 'vitest';
import { DEV_QUESTIONS } from '../golden/questions.ts';
import { validateAndRun } from '../shared/pipeline.ts';
import { EXAMPLE_PREFIX, SNIPPETS } from '../shared/snippets.ts';
import { retrieve, selectSnippets, tokenize, TOP_K } from '../worker/retrieve.ts';
import { engineAdapters, openEngine } from './engine.ts';

const examples = SNIPPETS.filter((s) => s.id.startsWith(EXAMPLE_PREFIX));

const exampleQuestion = (text: string) => text.match(/^Example: (.*)$/m)?.[1] ?? '';
const exampleSql = (text: string) => text.match(/^SQL: ([\s\S]*)$/m)?.[1] ?? '';

function jaccard(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  const shared = [...x].filter((t) => y.has(t)).length;
  return shared / (x.size + y.size - shared);
}

describe('snippets', () => {
  it('holds 15 to 25 snippets with unique ids and tags', () => {
    expect(SNIPPETS.length).toBeGreaterThanOrEqual(15);
    expect(SNIPPETS.length).toBeLessThanOrEqual(25);
    expect(new Set(SNIPPETS.map((s) => s.id)).size).toBe(SNIPPETS.length);
    for (const s of SNIPPETS) expect(s.tags.length, s.id).toBeGreaterThan(0);
  });

  it('no worked example asks a golden question', () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const question = exampleQuestion(example.text);
      expect(question, example.id).not.toBe('');
      for (const golden of DEV_QUESTIONS) expect(jaccard(question, golden.question), `${example.id} vs ${golden.id}`).toBeLessThan(0.5);
    }
  });

  it('every worked example passes the validator and returns rows on the locked engine', async () => {
    const adapters = engineAdapters(await openEngine());
    for (const example of examples) {
      const outcome = await validateAndRun(exampleSql(example.text), adapters, new AbortController().signal);
      expect(outcome.kind, `${example.id}: ${'message' in outcome ? outcome.message : ''}`).toBe('rows');
      if (outcome.kind === 'rows') expect(outcome.result.rows.length, example.id).toBeGreaterThan(0);
    }
  });
});

describe('retrieve', () => {
  it.each([
    ['Do people who pay cash leave smaller tips?', 'tips-not-recorded-for-cash'],
    ['average tip by borough', 'tips-not-recorded-for-cash'],
    ['Which day of the week is busier, Saturday or Sunday?', 'weekend-definition'],
    ['How long is a typical ride from LaGuardia?', 'trip-duration'],
    ['How long is a typical ride from LaGuardia?', 'airports'],
    ['How did ridership change between March and January?', 'january-only'],
    ['Show a crosstab of payment type by borough', 'pivot-syntax'],
    ['What is the 90th percentile fare?', 'duckdb-functions'],
    ['How many riders travel alone?', 'passenger-count'],
    ['Which rate code is most common for Nassau trips?', 'ratecode-values'],
    ['What were the busiest hours in the morning?', 'time-parts'],
    ['How many refunds were there?', 'negative-amounts'],
  ])('%j pulls %s', (question, id) => {
    expect(retrieve(question).map((s) => s.id)).toContain(id);
  });

  it(`returns at most ${TOP_K} snippets, best first, and nothing for an unrelated question`, () => {
    expect(retrieve('How do weekend trips compare with weekdays?').length).toBeLessThanOrEqual(TOP_K);
    expect(retrieve('How do weekend trips compare with weekdays?')[0]!.id).toBe('weekend-definition');
    expect(retrieve('qwerty zxcvb')).toEqual([]);
  });

  it('context none sends nothing, all sends every snippet, top4 sends the retrieved ones', () => {
    const question = 'Do people who pay cash leave smaller tips?';
    expect(selectSnippets(question, 'none')).toEqual([]);
    expect(selectSnippets(question, 'all')).toEqual(SNIPPETS);
    expect(selectSnippets(question, 'top4')).toEqual(retrieve(question));
  });
});
