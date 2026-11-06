export const MAX_ROWS = 1_000;

function endOfQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) i += 2;
      else return i + 1;
    } else i++;
  }
  return sql.length;
}

function endOfBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else i++;
  }
  return sql.length;
}

function endOfLineComment(sql: string, start: number): number {
  const newline = sql.indexOf('\n', start);
  return newline === -1 ? sql.length : newline + 1;
}

export function stripTail(sql: string): string {
  let bodyEnd = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(sql, i, ch);
      bodyEnd = i;
    } else if (sql.startsWith('--', i)) {
      i = endOfLineComment(sql, i);
    } else if (sql.startsWith('/*', i)) {
      i = endOfBlockComment(sql, i);
    } else {
      i++;
      if (ch !== ';' && !/\s/.test(ch)) bodyEnd = i;
    }
  }
  return sql.slice(0, bodyEnd);
}

export const wrap = (body: string) => `SELECT * FROM (\n${body}\n) LIMIT ${MAX_ROWS + 1}`;
