import { TABLE } from './schema.ts';
import { stripTail, wrap } from './wrap.ts';

export type Rejection =
  | { code: 'not_select' }
  | { code: 'syntax'; detail: string }
  | { code: 'multi_statement' }
  | { code: 'table_not_allowed'; name: string }
  | { code: 'function_blocked'; name: string };

export type Validation = { ok: true; run: string } | { ok: false; rejection: Rejection };

export type Serialize = (sql: string) => unknown;

export const SERIALIZE_SQL = 'SELECT json_serialize_sql(?::VARCHAR) AS ast';

const DENIED_FUNCTIONS = new Set(['query', 'query_table', 'current_setting']);
const DENIED_PREFIXES = ['duckdb_', 'pragma_'];
const TABLE_CATALOGS = new Set(['', 'memory']);
const TABLE_SCHEMAS = new Set(['', 'main']);
const FILE_READER = /^(read_|glob$|parquet_|sniff_csv$)|_scan$/;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === 'string' ? value : '');

const isDenied = (name: string) => DENIED_FUNCTIONS.has(name) || DENIED_PREFIXES.some((p) => name.startsWith(p));

function parseAst(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function checkTable(node: Node, ctes: ReadonlySet<string>): Rejection | null {
  const name = text(node.table_name);
  const catalog = text(node.catalog_name);
  const schema = text(node.schema_name);
  const lower = name.toLowerCase();
  if (lower === TABLE && TABLE_CATALOGS.has(catalog.toLowerCase()) && TABLE_SCHEMAS.has(schema.toLowerCase())) return null;
  if (catalog === '' && schema === '' && ctes.has(lower)) return null;
  return { code: 'table_not_allowed', name: [catalog, schema, name].filter(Boolean).join('.') || '(unnamed)' };
}

function checkNode(node: Node, ctes: ReadonlySet<string>): Rejection | null {
  if (node.type === 'BASE_TABLE') return checkTable(node, ctes);
  if (node.type === 'SHOW_REF' && text(node.table_name) !== '') return checkTable(node, ctes);
  if (node.type === 'TABLE_FUNCTION') {
    const fn = isNode(node.function) ? text(node.function.function_name) : '';
    return { code: 'function_blocked', name: fn.toLowerCase() || 'table function' };
  }
  if (node.class === 'FUNCTION') {
    const name = text(node.function_name).toLowerCase();
    if (isDenied(name)) return { code: 'function_blocked', name };
  }
  return null;
}

type CteEntry = { key: unknown; value: unknown };

function cteEntries(node: Node): CteEntry[] | null {
  const cteMap = node.cte_map;
  if (!isNode(cteMap) || !Array.isArray(cteMap.map)) return null;
  return cteMap.map.every((e) => isNode(e) && typeof e.key === 'string') ? (cteMap.map as CteEntry[]) : null;
}

function recursiveName(node: Node): string | null {
  return node.type === 'RECURSIVE_CTE_NODE' && typeof node.cte_name === 'string' ? node.cte_name.toLowerCase() : null;
}

function walk(value: unknown, ctes: ReadonlySet<string>): Rejection | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = walk(item, ctes);
      if (r) return r;
    }
    return null;
  }
  if (!isNode(value)) return null;

  let scope = ctes;
  const entries = cteEntries(value);
  if (entries) {
    const visible = new Set(ctes);
    for (const entry of entries) {
      const r = walk(entry.value, new Set(visible));
      if (r) return r;
      visible.add(String(entry.key).toLowerCase());
    }
    scope = visible;
  }

  const own = checkNode(value, scope);
  if (own) return own;

  const selfName = recursiveName(value);
  const recursiveScope = selfName === null ? scope : new Set([...scope, selfName]);

  for (const [key, child] of Object.entries(value)) {
    if (key === 'cte_map' && entries) continue;
    const r = walk(child, key === 'right' ? recursiveScope : scope);
    if (r) return r;
  }
  return null;
}

export function checkAst(json: unknown): Rejection | null {
  if (isNode(json) && json.error === true && json.error_type === 'parser') return { code: 'syntax', detail: text(json.error_message) };
  if (!isNode(json) || json.error !== false || !Array.isArray(json.statements) || json.statements.length === 0) return { code: 'not_select' };
  if (json.statements.length !== 1) return { code: 'multi_statement' };
  return walk(json.statements, new Set());
}

export function message(r: Rejection): string {
  switch (r.code) {
    case 'not_select':
      return 'Blocked: only a single SELECT is allowed';
    case 'syntax':
      return `Syntax error: ${r.detail}`;
    case 'multi_statement':
      return 'Blocked: one statement at a time';
    case 'table_not_allowed':
      return `Blocked: \`${r.name}\` is not available; only \`${TABLE}\` can be queried`;
    case 'function_blocked':
      return FILE_READER.test(r.name)
        ? `Blocked: \`${r.name}\` reads files; only \`${TABLE}\` is available`
        : `Blocked: \`${r.name}\` is not allowed; only \`${TABLE}\` and ordinary functions are available`;
  }
}

export async function validate(sql: string, serialize: Serialize): Promise<Validation> {
  const body = stripTail(sql);
  const run = wrap(body);
  for (const candidate of [body, run]) {
    let ast: unknown;
    try {
      ast = parseAst(await serialize(candidate));
    } catch {
      return { ok: false, rejection: { code: 'not_select' } };
    }
    const rejection = checkAst(ast);
    if (rejection?.code === 'syntax' && candidate === run) return { ok: false, rejection: { code: 'not_select' } };
    if (rejection) return { ok: false, rejection };
  }
  return { ok: true, run };
}
