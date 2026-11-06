import { bigintSafe } from '../shared/cells.ts';

export type CheckKind = 'exact' | 'top1' | 'any_of' | 'refuse';

export type Rows = readonly (readonly unknown[])[];

export type Table = { readonly columns: readonly unknown[]; readonly rows: Rows };

export type Observed = { kind: 'rows'; table: Table } | { kind: 'cannot_answer' } | { kind: 'failed' };

export type Verdict = { pass: boolean; matched: number | null };

type Normal = string | number | boolean | null;

const NUMBER_TEXT = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

export function normalize(value: unknown): Normal {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return round2(value);
  if (typeof value === 'bigint') return round2(Number(value));
  if (typeof value === 'string') return NUMBER_TEXT.test(value.trim()) ? round2(Number(value)) : value;
  if (typeof value === 'boolean') return value;
  return JSON.stringify(value, bigintSafe);
}

const rowKey = (row: readonly unknown[]) => JSON.stringify(row.map(normalize));

function sortedKeys(rows: Rows): string[] {
  return rows.map(rowKey).sort();
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, i) => key === b[i]);

const columnSignature = (rows: Rows, j: number) => rows.map((row) => JSON.stringify(normalize(row[j]))).sort().join('\n');

const reorder = (rows: Rows, order: readonly number[]): Rows => rows.map((row) => order.map((j) => row[j]));

function matchesInSomeColumnOrder(got: Table, want: Table): boolean {
  const expected = sortedKeys(want.rows);
  const gotSignatures = got.columns.map((_, j) => columnSignature(got.rows, j));
  const wantSignatures = want.columns.map((_, k) => columnSignature(want.rows, k));
  const search = (order: number[]): boolean =>
    order.length === wantSignatures.length
      ? sameKeys(sortedKeys(reorder(got.rows, order)), expected)
      : gotSignatures.some((signature, j) => signature === wantSignatures[order.length] && !order.includes(j) && search([...order, j]));
  return search([]);
}

export function exact(got: Table, want: Table): boolean {
  if (got.columns.length !== want.columns.length || got.rows.length !== want.rows.length) return false;
  return matchesInSomeColumnOrder(got, want);
}

export function top1(got: Table, want: Table): boolean {
  const first = got.rows[0];
  const expected = want.rows[0];
  if (!first || !expected || expected.length === 0) return false;
  const key = normalize(expected[0]);
  return first.some((value) => normalize(value) === key);
}

export function anyOf(got: Table, wants: readonly Table[]): Verdict {
  const matched = wants.findIndex((want) => exact(got, want));
  return matched === -1 ? { pass: false, matched: null } : { pass: true, matched };
}

export function check(kind: CheckKind, observed: Observed, references: readonly Table[]): Verdict {
  if (kind === 'refuse') return { pass: observed.kind === 'cannot_answer', matched: null };
  const [reference] = references;
  if (observed.kind !== 'rows' || !reference) return { pass: false, matched: null };
  switch (kind) {
    case 'exact':
      return { pass: exact(observed.table, reference), matched: null };
    case 'top1':
      return { pass: top1(observed.table, reference), matched: null };
    case 'any_of':
      return anyOf(observed.table, references);
  }
}
