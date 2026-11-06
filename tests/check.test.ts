import { describe, expect, it } from 'vitest';
import { anyOf, check, exact, normalize, top1, type Rows, type Table } from '../golden/check.ts';

const table = (columns: readonly unknown[], rows: Rows): Table => ({ columns, rows });

const boroughs = table(
  ['pickup_borough', 'avg_tip'],
  [
    ['EWR', 13.47119133574006],
    ['Queens', 10.170000001],
    ['Manhattan', 3.3412],
  ],
);

describe('normalize', () => {
  it('rounds numbers to 2 dp', () => {
    expect(normalize(13.47119133574006)).toBe(13.47);
    expect(normalize(9.199999)).toBe(9.2);
    expect(normalize(-0.001)).toBe(0);
  });

  it('treats BigInt and numeric strings as numbers', () => {
    expect(normalize(140162n)).toBe(140162);
    expect(normalize('140162')).toBe(140162);
    expect(normalize('4.1696')).toBe(4.17);
  });

  it('keeps labels and dates as text', () => {
    expect(normalize('N/A')).toBe('N/A');
    expect(normalize('2024-01-01')).toBe('2024-01-01');
    expect(normalize(null)).toBeNull();
  });
});

describe('exact', () => {
  it('ignores column names', () => {
    const renamed = table(['borough', 'tip'], boroughs.rows.map((r) => [...r]));
    expect(exact(renamed, boroughs)).toBe(true);
  });

  it('ignores column order', () => {
    const swapped = table(['avg_tip', 'pickup_borough'], boroughs.rows.map(([borough, tip]) => [tip, borough]));
    expect(exact(swapped, boroughs)).toBe(true);
  });

  it('does not pair values across rows when columns are reordered', () => {
    const want = table(['a', 'b'], [[1, 2], [3, 4]]);
    expect(exact(table(['b', 'a'], [[2, 1], [4, 3]]), want)).toBe(true);
    expect(exact(table(['b', 'a'], [[4, 1], [2, 3]]), want)).toBe(false);
  });

  it('ignores row order by sorting on all columns', () => {
    const shuffled = table(boroughs.columns.slice(), [boroughs.rows[2]!.slice(), boroughs.rows[0]!.slice(), boroughs.rows[1]!.slice()]);
    expect(exact(shuffled, boroughs)).toBe(true);
  });

  it('matches after rounding to 2 dp', () => {
    const rounded = table(['b', 't'], [
      ['EWR', 13.47],
      ['Queens', 10.17],
      ['Manhattan', 3.34],
    ]);
    expect(exact(rounded, boroughs)).toBe(true);
  });

  it('fails on a value that differs after rounding', () => {
    const withCash = table(['b', 't'], [
      ['EWR', 12.65],
      ['Queens', 10.17],
      ['Manhattan', 3.34],
    ]);
    expect(exact(withCash, boroughs)).toBe(false);
  });

  it('fails on an extra column or a missing row', () => {
    expect(exact(table(['b', 't', 'n'], boroughs.rows.map((r) => [...r, 1])), boroughs)).toBe(false);
    expect(exact(table(['b', 't'], boroughs.rows.slice(0, 2)), boroughs)).toBe(false);
  });

  it('compares a BigInt count with the string the browser returns', () => {
    expect(exact(table(['n'], [['140162']]), table(['trips'], [[140162n]]))).toBe(true);
  });

  it('treats duplicate rows as a multiset', () => {
    expect(exact(table(['x'], [[1], [1], [2]]), table(['x'], [[1], [2], [2]]))).toBe(false);
  });
});

describe('top1', () => {
  it('compares only the first column of the first row', () => {
    expect(top1(table(['p', 'avg'], [['Credit card', 99]]), table(['payment_type', 't'], [['Credit card', 4.17], ['Flex fare', 1.55]]))).toBe(true);
  });

  it('finds the key in any column of the first row', () => {
    const want = table(['payment_type', 't'], [['Credit card', 4.17], ['Flex fare', 1.55]]);
    expect(top1(table(['avg', 'p'], [[4.17, 'Credit card'], [1.55, 'Flex fare']]), want)).toBe(true);
    expect(top1(table(['avg', 'n', 'p'], [[4.17, 9, 'Credit card']]), want)).toBe(true);
    expect(top1(table(['p'], [['Credit card']]), want)).toBe(true);
  });

  it('fails when the leader differs or there are no rows', () => {
    const want = table(['z'], [['JFK Airport']]);
    expect(top1(table(['z'], [['LaGuardia Airport']]), want)).toBe(false);
    expect(top1(table(['z'], []), want)).toBe(false);
  });
});

describe('anyOf', () => {
  const byDistance = table(['longest'], [[312722.3]]);
  const byDuration = table(['longest'], [[9455]]);

  it('ignores column order in every reading', () => {
    const byPair = table(['miles', 'minutes'], [[312722.3, 9455]]);
    expect(anyOf(table(['minutes', 'miles'], [[9455, 312722.3]]), [byDistance, byPair])).toEqual({ pass: true, matched: 1 });
  });

  it('records which reading won', () => {
    expect(anyOf(table(['minutes'], [[9455]]), [byDistance, byDuration])).toEqual({ pass: true, matched: 1 });
    expect(anyOf(table(['miles'], [[312722.3]]), [byDistance, byDuration])).toEqual({ pass: true, matched: 0 });
  });

  it('fails when no reading matches', () => {
    expect(anyOf(table(['x'], [[1]]), [byDistance, byDuration])).toEqual({ pass: false, matched: null });
  });
});

describe('check', () => {
  it('passes refuse only on cannot_answer', () => {
    expect(check('refuse', { kind: 'cannot_answer' }, [])).toEqual({ pass: true, matched: null });
    expect(check('refuse', { kind: 'rows', table: boroughs }, [])).toEqual({ pass: false, matched: null });
  });

  it('fails a row check when the model refused or the run failed', () => {
    expect(check('exact', { kind: 'cannot_answer' }, [boroughs]).pass).toBe(false);
    expect(check('top1', { kind: 'failed' }, [boroughs]).pass).toBe(false);
  });

  it('dispatches exact, top1 and any_of', () => {
    const observed = { kind: 'rows', table: boroughs } as const;
    expect(check('exact', observed, [boroughs]).pass).toBe(true);
    expect(check('top1', observed, [boroughs]).pass).toBe(true);
    expect(check('any_of', observed, [table(['x'], [[1]]), boroughs])).toEqual({ pass: true, matched: 1 });
  });
});
