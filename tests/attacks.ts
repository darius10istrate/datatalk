export type Expectation = 'blocked' | 'allowed' | 'runaway';

export type Attack = {
  sql: string;
  category: string;
  expect: Expectation;
  run?: false;
};

const longLiteral = `SELECT '${'a'.repeat(100_000)}' AS long_text`;

export const INJECTION = "SELECT 1 AS x'); DROP TABLE trips; --";

export const ATTACKS: readonly Attack[] = [
  { category: 'Must pass', expect: 'allowed', sql: 'SELECT count(*) FROM trips' },
  { category: 'Must pass', expect: 'allowed', sql: 'SELECT pickup_borough, round(avg(tip_amount), 2) AS avg_tip FROM trips GROUP BY ALL ORDER BY avg_tip DESC' },
  { category: 'Must pass', expect: 'allowed', sql: 'SELECT pickup_zone, count(*) AS n FROM trips GROUP BY pickup_zone QUALIFY row_number() OVER (ORDER BY n DESC) <= 3' },
  { category: 'Must pass', expect: 'allowed', sql: "SELECT strftime(pickup_at, '%Y-%m-%d') AS day, count(*) AS n FROM trips GROUP BY ALL ORDER BY day" },
  { category: 'Must pass', expect: 'allowed', sql: "FROM trips PIVOT (count(*) FOR payment_type IN ('Cash', 'Credit card'))" },
  { category: 'Must pass', expect: 'allowed', sql: 'FROM (SELECT 1 AS a, 2 AS b) UNPIVOT (v FOR k IN (a, b))' },
  { category: 'Must pass', expect: 'allowed', sql: 'FROM trips SELECT * EXCLUDE (dropoff_zone) LIMIT 5' },
  { category: 'Must pass', expect: 'allowed', sql: 'SELECT * FROM TRIPS LIMIT 1' },
  { category: 'Must pass', expect: 'allowed', sql: 'SELECT 1 UNION ALL SELECT 2' },
  { category: 'Must pass', expect: 'allowed', sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r' },
  { category: 'Must pass', expect: 'allowed', sql: 'DESCRIBE trips' },
  { category: 'Must pass', expect: 'allowed', sql: 'SUMMARIZE trips' },

  { category: 'Plain write', expect: 'blocked', sql: 'DROP TABLE trips' },
  { category: 'Plain write', expect: 'blocked', sql: 'DROP VIEW trips' },
  { category: 'Plain write', expect: 'blocked', sql: 'DELETE FROM trips' },
  { category: 'Plain write', expect: 'blocked', sql: 'CREATE TABLE x AS SELECT * FROM trips' },
  { category: 'Plain write', expect: 'blocked', sql: 'INSERT INTO trips SELECT * FROM trips LIMIT 1' },

  { category: 'Stacked', expect: 'blocked', sql: 'SELECT 1; DROP VIEW trips' },
  { category: 'Stacked', expect: 'blocked', sql: 'SELECT 1;\nDROP VIEW trips' },
  { category: 'Stacked', expect: 'blocked', sql: 'SELECT 1; SELECT 2' },

  { category: 'Trailing tail', expect: 'allowed', sql: 'SELECT 1;' },
  { category: 'Trailing tail', expect: 'allowed', sql: 'SELECT 1; ' },
  { category: 'Trailing tail', expect: 'allowed', sql: 'SELECT 1;\n' },
  { category: 'Trailing tail', expect: 'allowed', sql: 'SELECT 1;;' },
  { category: 'Trailing tail', expect: 'allowed', sql: 'SELECT 1; -- done' },
  { category: 'Trailing tail', expect: 'allowed', sql: 'SELECT 1 /* done */ ;\n-- really\n' },

  { category: 'Wrapper break-out', expect: 'blocked', sql: 'SELECT 1 x) UNION ALL (SELECT 2' },

  { category: 'CTEs', expect: 'allowed', sql: 'WITH t AS (SELECT 1 AS a) SELECT * FROM t' },
  { category: 'CTEs', expect: 'allowed', sql: 'WITH trips AS (SELECT 1 AS a) SELECT * FROM trips' },
  { category: 'CTEs', expect: 'blocked', sql: "WITH t AS (SELECT * FROM read_csv('/etc/passwd')) SELECT * FROM t" },
  { category: 'CTEs', expect: 'blocked', sql: 'WITH duckdb_databases AS (SELECT 1) SELECT * FROM system.main.duckdb_databases' },
  { category: 'CTEs', expect: 'blocked', sql: 'SELECT * FROM (WITH duckdb_tables AS (SELECT 1) SELECT * FROM duckdb_tables), duckdb_tables' },
  { category: 'CTEs', expect: 'blocked', sql: 'WITH duckdb_databases AS (SELECT database_name, path, type FROM duckdb_databases) SELECT * FROM duckdb_databases' },
  { category: 'CTEs', expect: 'blocked', sql: 'WITH duckdb_views AS (SELECT view_name, sql, internal FROM duckdb_views) SELECT view_name, sql FROM duckdb_views WHERE NOT internal' },
  { category: 'CTEs', expect: 'blocked', sql: 'WITH duckdb_columns AS (SELECT table_name, column_name FROM duckdb_columns) SELECT count(*)::INT AS n FROM duckdb_columns' },
  { category: 'CTEs', expect: 'blocked', sql: 'WITH RECURSIVE duckdb_databases AS (SELECT database_name FROM duckdb_databases UNION SELECT database_name FROM duckdb_databases) SELECT * FROM duckdb_databases' },
  { category: 'CTEs', expect: 'allowed', sql: 'WITH RECURSIVE a AS (SELECT 1 AS n), b AS (SELECT n FROM a UNION SELECT n + 1 FROM b WHERE n < 3) SELECT * FROM b' },

  { category: 'Qualified names', expect: 'allowed', sql: 'SELECT count(*) FROM memory.main.trips' },
  { category: 'Qualified names', expect: 'allowed', sql: 'SELECT count(*) FROM main.trips' },
  { category: 'Qualified names', expect: 'blocked', sql: 'SELECT * FROM information_schema.tables' },
  { category: 'Qualified names', expect: 'blocked', sql: 'SELECT * FROM system.main.duckdb_settings' },
  { category: 'Qualified names', expect: 'blocked', sql: 'SELECT * FROM duckdb_views' },
  { category: 'Qualified names', expect: 'blocked', sql: 'SHOW TABLES' },

  { category: 'Comments', expect: 'allowed', sql: 'SELECT 1 /* ; DROP VIEW trips */' },
  { category: 'Comments', expect: 'blocked', sql: 'DR/**/OP VIEW trips' },
  { category: 'Comments', expect: 'allowed', sql: 'SELECT count(*) FROM trips --) UNION ALL (SELECT 2' },

  { category: 'Files / network', expect: 'blocked', sql: "SELECT * FROM read_csv('/etc/passwd')" },
  { category: 'Files / network', expect: 'blocked', sql: "SELECT * FROM 'https://example.com/a.parquet'" },
  { category: 'Files / network', expect: 'blocked', sql: "SELECT * FROM read_text('trips.parquet')" },
  { category: 'Files / network', expect: 'blocked', sql: "SELECT * FROM glob('*')" },
  { category: 'Files / network', expect: 'blocked', sql: "SELECT * FROM parquet_metadata('trips.parquet')" },
  { category: 'Files / network', expect: 'blocked', sql: "SUMMARIZE 'x.csv'" },
  { category: 'Files / network', expect: 'blocked', sql: "SELECT * FROM 'trips.parquet'" },

  { category: 'Indirection', expect: 'blocked', sql: "SELECT * FROM query(chr(83) || 'ELECT 7')" },
  { category: 'Indirection', expect: 'blocked', sql: "SELECT * FROM query('DROP VIEW trips')" },
  { category: 'Indirection', expect: 'blocked', sql: "SELECT * FROM query_table('tr' || 'ips')" },
  { category: 'Indirection', expect: 'blocked', sql: "SELECT (SELECT query('SELECT 7'))" },
  { category: 'Indirection', expect: 'blocked', sql: "SELECT list_transform([1], x -> query('SELECT 7'))" },
  { category: 'Indirection', expect: 'blocked', sql: "SELECT 1 ORDER BY QUERY('SELECT 7')" },
  { category: 'Indirection', expect: 'blocked', sql: 'SELECT count(*) FROM trips WHERE EXISTS (SELECT * FROM system.main.duckdb_tables)' },

  { category: 'ATTACH / COPY', expect: 'blocked', sql: "ATTACH ':memory:' AS x" },
  { category: 'ATTACH / COPY', expect: 'blocked', sql: "COPY (SELECT 1 AS a) TO 'trips.parquet'" },
  { category: 'ATTACH / COPY', expect: 'blocked', sql: "EXPORT DATABASE 'x'" },

  { category: 'Config / leaks', expect: 'blocked', sql: "SET memory_limit = '8GB'" },
  { category: 'Config / leaks', expect: 'blocked', sql: 'PRAGMA version' },
  { category: 'Config / leaks', expect: 'blocked', sql: "SELECT current_setting('allowed_paths')" },
  { category: 'Config / leaks', expect: 'blocked', sql: 'SELECT * FROM duckdb_settings()' },
  { category: 'Config / leaks', expect: 'blocked', sql: 'SELECT * FROM pragma_version()' },
  { category: 'Config / leaks', expect: 'blocked', sql: 'SELECT main.duckdb_extensions()' },

  { category: 'Runaway', expect: 'runaway', sql: 'SELECT range(10000000000)' },
  { category: 'Runaway', expect: 'runaway', sql: "SELECT repeat('x', 2000000000)" },
  { category: 'Runaway', expect: 'runaway', sql: 'FROM trips a, trips b WHERE a.fare_amount < b.fare_amount', run: false },

  { category: 'Validator itself', expect: 'blocked', sql: INJECTION },
  { category: 'Validator itself', expect: 'blocked', sql: 'ＳＥＬＥＣＴ 1' },
  { category: 'Validator itself', expect: 'blocked', sql: 'SELECT * FROM trірs' },
  { category: 'Validator itself', expect: 'blocked', sql: 'DRОP VIEW trips' },
  { category: 'Validator itself', expect: 'allowed', sql: longLiteral },

  { category: 'Known false positive', expect: 'blocked', sql: 'SELECT * FROM (PIVOT trips ON payment_type USING count(*))' },
  { category: 'Known false positive', expect: 'blocked', sql: 'SELECT * FROM generate_series(1, 3)' },
  { category: 'Known false positive', expect: 'blocked', sql: 'SELECT * FROM unnest([1, 2, 3])' },
  { category: 'Known false positive', expect: 'blocked', sql: "SELECT $$it's$$ AS s;" },
  { category: 'Known false positive', expect: 'blocked', sql: 'SELECT $$a--b$$ AS s' },
  { category: 'Known false positive', expect: 'blocked', sql: "SELECT E'a\\'b';" },
];
