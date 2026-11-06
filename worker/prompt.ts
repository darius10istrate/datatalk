import type { Problem, RetryCode, SqlRequest } from '../shared/api.ts';
import { DUCKDB_VERSION } from '../shared/lockdown.ts';
import { COLUMNS, ddl, TABLE } from '../shared/schema.ts';
import type { Snippet } from '../shared/snippets.ts';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const RULES = [
  `Write one DuckDB ${DUCKDB_VERSION} SELECT statement over the table ${TABLE} that answers the question.`,
  `Only the table ${TABLE} exists. Do not read files or URLs, do not use table functions in FROM, and do not query system tables or settings.`,
  'Use only the columns listed in the schema. Text columns hold the exact labels given in the column descriptions.',
  'Write one statement with no trailing semicolon. Prefer clear column aliases and ORDER BY for ranked answers.',
  'If the table cannot answer the question (another month or year, data it does not hold, or not a question about this data), answer with kind "cannot_answer" and a one-sentence reason.',
  'Return JSON only. For kind "sql": set sql and a one-sentence rationale that states any assumption or filter, and leave reason empty. For kind "cannot_answer": set reason and leave sql and rationale empty.',
];

export function systemPrompt(snippets: readonly Snippet[]): string {
  const parts = [
    'You translate questions about NYC yellow taxi trips into DuckDB SQL.',
    RULES.map((r) => `- ${r}`).join('\n'),
    `Schema:\n${ddl()}`,
  ];
  if (snippets.length > 0) parts.push(`Notes:\n${snippets.map((s) => `[${s.id}] ${s.text}`).join('\n')}`);
  return parts.join('\n\n');
}

const named = (name: string | undefined, fallback: string) => (name ? `\`${name}\`` : fallback);

export const RETRY_TEMPLATES: Record<RetryCode, (name?: string) => string> = {
  not_select: () => 'The previous SQL was rejected: only a single SELECT statement is allowed.',
  multi_statement: () => 'The previous SQL was rejected: it contained more than one statement. Write exactly one SELECT.',
  table_not_allowed: (name) => `The previous SQL was rejected: it read ${named(name, 'a table')}, but only ${TABLE} can be queried.`,
  function_blocked: (name) =>
    `The previous SQL was rejected: the function ${named(name, 'it used')} is not allowed. Use ordinary scalar and aggregate functions over ${TABLE}.`,
  unknown_column: (name) => `The previous SQL failed: the column ${named(name, 'it referenced')} does not exist.`,
  unknown_function: (name) => `The previous SQL failed: the function ${named(name, 'it called')} does not exist in DuckDB.`,
  syntax: () => 'The previous SQL failed with a syntax error.',
};

export function retryMessage(problem: Problem): string {
  const columns = COLUMNS.map((c) => c.name).join(', ');
  return `${RETRY_TEMPLATES[problem.code](problem.name)} Valid columns: ${columns}. Answer the original question again.`;
}

export function buildMessages(request: SqlRequest, snippets: readonly Snippet[]): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(snippets) },
    { role: 'user', content: request.question },
  ];
  if (request.previous_sql !== undefined && request.problem) {
    messages.push(
      { role: 'assistant', content: JSON.stringify({ kind: 'sql', sql: request.previous_sql, rationale: '', reason: '' }) },
      { role: 'user', content: retryMessage(request.problem) },
    );
  }
  return messages;
}
