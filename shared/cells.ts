import { DataType, type Field, type RecordBatch, type Table } from 'apache-arrow';

export type Cell = string | number | boolean | null;

export const isNumeric = (type: DataType) => DataType.isInt(type) || DataType.isFloat(type) || DataType.isDecimal(type);

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function formatInstant(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date;
}

export const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function toCell(value: unknown, type: DataType): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (DataType.isTimestamp(type) || DataType.isDate(type)) {
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return formatInstant(ms, DataType.isTimestamp(type));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value, bigintSafe);
}

export function batchToRows(fields: readonly Field[], batch: Table | RecordBatch, limit = Infinity): Cell[][] {
  const columns = fields.map((_, j) => batch.getChildAt(j)!);
  const count = Math.min(batch.numRows, limit);
  return Array.from({ length: count }, (_, i) => columns.map((column, j) => toCell(column.get(i), fields[j]!.type)));
}
