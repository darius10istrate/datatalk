import type { Context } from '../shared/api.ts';
import { SNIPPETS, type Snippet } from '../shared/snippets.ts';

export const TOP_K = 4;

const K1 = 1.2;
const B = 0.75;
const TAG_WEIGHT = 2;

const STOPWORDS = new Set(
  'a about all an and any are as at be by can did do does each for from had has have how i in is it its many me much of on or per show that the their there these this to was were what when where which who why with would you'.split(
    ' ',
  ),
);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w)).map(stem);
}

type Indexed = { snippet: Snippet; counts: Map<string, number>; length: number };

function index(snippet: Snippet): Indexed {
  const terms = [...tokenize(snippet.text), ...Array.from({ length: TAG_WEIGHT }, () => snippet.tags.flatMap(tokenize)).flat()];
  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { snippet, counts, length: terms.length };
}

export type Scored = { snippet: Snippet; score: number };

export function rank(question: string, snippets: readonly Snippet[] = SNIPPETS): Scored[] {
  const docs = snippets.map(index);
  const n = docs.length;
  if (n === 0) return [];
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / n;
  const queryTerms = [...new Set(tokenize(question))];
  const idf = new Map(
    queryTerms.map((t) => {
      const df = docs.filter((d) => d.counts.has(t)).length;
      return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))] as const;
    }),
  );
  const scored = docs.map(({ snippet, counts, length }) => {
    let score = 0;
    for (const t of queryTerms) {
      const tf = counts.get(t) ?? 0;
      if (tf === 0) continue;
      score += idf.get(t)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avgLength)));
    }
    return { snippet, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.snippet.id.localeCompare(b.snippet.id));
}

export function retrieve(question: string, k = TOP_K, snippets: readonly Snippet[] = SNIPPETS): Snippet[] {
  return rank(question, snippets)
    .slice(0, k)
    .map((s) => s.snippet);
}

export function selectSnippets(question: string, context: Context): readonly Snippet[] {
  switch (context) {
    case 'none':
      return [];
    case 'all':
      return SNIPPETS;
    case 'top4':
      return retrieve(question);
  }
}
