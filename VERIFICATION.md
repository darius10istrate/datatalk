# Verification

All numbers below are pasted from command output on 2026-11-06. The descriptions of the app refer to the code files that they name.

## What was tested and how

| Item | Value |
| --- | --- |
| Model | `google/gemini-3.7-flash` (configured in `.env`; every run's `models_served` is the same ID) |
| Provider | Not pinned: `OPENROUTER_PROVIDER` was empty, so OpenRouter picked any endpoint with `require_parameters: true`. `04` question 11 asked for a pinned provider; this run did not have one. |
| Sampling | `temperature: 0` (`worker/openrouter.ts`) |
| Engine | DuckDB-WASM 1.32.0 Node blocking build, DuckDB `v1.4.3`, the same view and `LOCKDOWN` as the browser (`tests/engine.ts`) |
| Dataset | 2,964,606 trips, fingerprint `012421da9476471f` |
| Golden runs | 2026-11-06 13:46–14:04 UTC, through `shared/pipeline.ts` (validate → wrap → run → one retry), as the UI does |
| Sets | dev: 13 questions in `golden/questions.ts`, written before the prompt existed. Holdout: 8 questions in `golden/holdout.ts`, written after `shared/snippets.ts` was committed (da1eccb) |
| Arms | `none` (schema only), `all` (all 23 snippets), `top4` (BM25 top 4), 3 runs per question per arm |

Commands:

```text
npm run golden -- --reference --set holdout                       # ok: 8 questions
npm run golden -- --set <dev|holdout> --context <none|all|top4> --runs 3
npx tsx golden/compare.ts golden/out/*T*.json
npm test                                                          # prints the attack table
```

Holdout references (`npm run golden -- --reference --set holdout`):

```text
jfk-airport-pickups       1 row · trips=145240
cash-share                1 row · pct_cash=14.814278862014042
busiest-hour              24 rows · first row: hour=18, trips=212788
weekday-avg-fare          ref 1: avg_fare=18.37348893403167 · ref 2 (fare_amount > 0): avg_fare=18.84785402516586
jfk-dropoff-tip           1 row · avg_tip=11.734850629578172
missing-passenger-count   1 row · trips=140162
quietest-day              31 rows · first row: day=2024-01-07, trips=67543
march-revenue             refuse: no reference SQL; passes when the model answers cannot_answer
ok: 8 questions
```

## Validator

Attack table printed by `tests/validate.test.ts` (`npm test`: 7 files, 206 tests passed). "Result" is the validator on the locked engine; "Without validator" runs the same SQL on a lockdown-only engine.

| Category | SQL | Expected | Result | Reason | Without validator |
| --- | --- | --- | --- | --- | --- |
| Must pass | `SELECT count(*) FROM trips` | allowed | not blocked |  | same |
| Must pass | `SELECT pickup_borough, round(avg(tip_amount), 2) AS avg_tip … (105 chars)` | allowed | not blocked |  | same |
| Must pass | `SELECT pickup_zone, count(*) AS n FROM trips GROUP BY pickup… (114 chars)` | allowed | not blocked |  | same |
| Must pass | `SELECT strftime(pickup_at, '%Y-%m-%d') AS day, count(*) AS n… (97 chars)` | allowed | not blocked |  | same |
| Must pass | `FROM trips PIVOT (count(*) FOR payment_type IN ('Cash', 'Credit card'))` | allowed | not blocked |  | same |
| Must pass | `FROM (SELECT 1 AS a, 2 AS b) UNPIVOT (v FOR k IN (a, b))` | allowed | not blocked |  | same |
| Must pass | `FROM trips SELECT * EXCLUDE (dropoff_zone) LIMIT 5` | allowed | not blocked |  | same |
| Must pass | `SELECT * FROM TRIPS LIMIT 1` | allowed | not blocked |  | same |
| Must pass | `SELECT 1 UNION ALL SELECT 2` | allowed | not blocked |  | same |
| Must pass | `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM… (91 chars)` | allowed | not blocked |  | same |
| Must pass | `DESCRIBE trips` | allowed | not blocked |  | same |
| Must pass | `SUMMARIZE trips` | allowed | not blocked |  | same |
| Plain write | `DROP TABLE trips` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | blocked |
| Plain write | `DROP VIEW trips` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Plain write | `DELETE FROM trips` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | blocked |
| Plain write | `CREATE TABLE x AS SELECT * FROM trips` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Plain write | `INSERT INTO trips SELECT * FROM trips LIMIT 1` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | blocked |
| Stacked | `SELECT 1; DROP VIEW trips` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Stacked | `SELECT 1;\nDROP VIEW trips` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Stacked | `SELECT 1; SELECT 2` | blocked | blocked by validator | Blocked: one statement at a time | ran |
| Trailing tail | `SELECT 1;` | allowed | not blocked |  | same |
| Trailing tail | `SELECT 1; ` | allowed | not blocked |  | same |
| Trailing tail | `SELECT 1;\n` | allowed | not blocked |  | same |
| Trailing tail | `SELECT 1;;` | allowed | not blocked |  | same |
| Trailing tail | `SELECT 1; -- done` | allowed | not blocked |  | same |
| Trailing tail | `SELECT 1 /* done */ ;\n-- really\n` | allowed | not blocked |  | same |
| Wrapper break-out | `SELECT 1 x) UNION ALL (SELECT 2` | blocked | blocked by validator | Syntax error: syntax error at or near ")" | blocked |
| CTEs | `WITH t AS (SELECT 1 AS a) SELECT * FROM t` | allowed | not blocked |  | same |
| CTEs | `WITH trips AS (SELECT 1 AS a) SELECT * FROM trips` | allowed | not blocked |  | same |
| CTEs | `WITH t AS (SELECT * FROM read_csv('/etc/passwd')) SELECT * FROM t` | blocked | blocked by validator | Blocked: `read_csv` reads files; only `trips` is available | blocked |
| CTEs | `WITH duckdb_databases AS (SELECT 1) SELECT * FROM system.main.duckdb_databases` | blocked | blocked by validator | Blocked: `system.main.duckdb_databases` is not available; only `trips` can be queried | ran |
| CTEs | `SELECT * FROM (WITH duckdb_tables AS (SELECT 1) SELECT * FRO… (91 chars)` | blocked | blocked by validator | Blocked: `duckdb_tables` is not available; only `trips` can be queried | ran |
| CTEs | `WITH duckdb_databases AS (SELECT database_name, path, type F… (112 chars)` | blocked | blocked by validator | Blocked: `duckdb_databases` is not available; only `trips` can be queried | ran |
| CTEs | `WITH duckdb_views AS (SELECT view_name, sql, internal FROM d… (131 chars)` | blocked | blocked by validator | Blocked: `duckdb_views` is not available; only `trips` can be queried | ran |
| CTEs | `WITH duckdb_columns AS (SELECT table_name, column_name FROM … (121 chars)` | blocked | blocked by validator | Blocked: `duckdb_columns` is not available; only `trips` can be queried | ran |
| CTEs | `WITH RECURSIVE duckdb_databases AS (SELECT database_name FRO… (159 chars)` | blocked | blocked by validator | Blocked: `duckdb_databases` is not available; only `trips` can be queried | ran |
| CTEs | `WITH RECURSIVE a AS (SELECT 1 AS n), b AS (SELECT n FROM a U… (113 chars)` | allowed | not blocked |  | same |
| Qualified names | `SELECT count(*) FROM memory.main.trips` | allowed | not blocked |  | same |
| Qualified names | `SELECT count(*) FROM main.trips` | allowed | not blocked |  | same |
| Qualified names | `SELECT * FROM information_schema.tables` | blocked | blocked by validator | Blocked: `information_schema.tables` is not available; only `trips` can be queried | ran |
| Qualified names | `SELECT * FROM system.main.duckdb_settings` | blocked | blocked by validator | Blocked: `system.main.duckdb_settings` is not available; only `trips` can be queried | blocked |
| Qualified names | `SELECT * FROM duckdb_views` | blocked | blocked by validator | Blocked: `duckdb_views` is not available; only `trips` can be queried | ran |
| Qualified names | `SHOW TABLES` | blocked | blocked by validator | Blocked: `"tables"` is not available; only `trips` can be queried | ran |
| Comments | `SELECT 1 /* ; DROP VIEW trips */` | allowed | not blocked |  | same |
| Comments | `DR/**/OP VIEW trips` | blocked | blocked by validator | Syntax error: syntax error at or near "DR" | blocked |
| Comments | `SELECT count(*) FROM trips --) UNION ALL (SELECT 2` | allowed | not blocked |  | same |
| Files / network | `SELECT * FROM read_csv('/etc/passwd')` | blocked | blocked by validator | Blocked: `read_csv` reads files; only `trips` is available | blocked |
| Files / network | `SELECT * FROM 'https://example.com/a.parquet'` | blocked | blocked by validator | Blocked: `https://example.com/a.parquet` is not available; only `trips` can be queried | blocked |
| Files / network | `SELECT * FROM read_text('trips.parquet')` | blocked | blocked by validator | Blocked: `read_text` reads files; only `trips` is available | blocked |
| Files / network | `SELECT * FROM glob('*')` | blocked | blocked by validator | Blocked: `glob` reads files; only `trips` is available | blocked |
| Files / network | `SELECT * FROM parquet_metadata('trips.parquet')` | blocked | blocked by validator | Blocked: `parquet_metadata` reads files; only `trips` is available | ran |
| Files / network | `SUMMARIZE 'x.csv'` | blocked | blocked by validator | Blocked: `x.csv` is not available; only `trips` can be queried | blocked |
| Files / network | `SELECT * FROM 'trips.parquet'` | blocked | blocked by validator | Blocked: `trips.parquet` is not available; only `trips` can be queried | ran |
| Indirection | `SELECT * FROM query(chr(83) \|\| 'ELECT 7')` | blocked | blocked by validator | Blocked: `query` is not allowed; only `trips` and ordinary functions are available | ran |
| Indirection | `SELECT * FROM query('DROP VIEW trips')` | blocked | blocked by validator | Blocked: `query` is not allowed; only `trips` and ordinary functions are available | blocked |
| Indirection | `SELECT * FROM query_table('tr' \|\| 'ips')` | blocked | blocked by validator | Blocked: `query_table` is not allowed; only `trips` and ordinary functions are available | ran |
| Indirection | `SELECT (SELECT query('SELECT 7'))` | blocked | blocked by validator | Blocked: `query` is not allowed; only `trips` and ordinary functions are available | blocked |
| Indirection | `SELECT list_transform([1], x -> query('SELECT 7'))` | blocked | blocked by validator | Blocked: `query` is not allowed; only `trips` and ordinary functions are available | blocked |
| Indirection | `SELECT 1 ORDER BY QUERY('SELECT 7')` | blocked | blocked by validator | Blocked: `query` is not allowed; only `trips` and ordinary functions are available | blocked |
| Indirection | `SELECT count(*) FROM trips WHERE EXISTS (SELECT * FROM system.main.duckdb_tables)` | blocked | blocked by validator | Blocked: `system.main.duckdb_tables` is not available; only `trips` can be queried | ran |
| ATTACH / COPY | `ATTACH ':memory:' AS x` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| ATTACH / COPY | `COPY (SELECT 1 AS a) TO 'trips.parquet'` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | blocked |
| ATTACH / COPY | `EXPORT DATABASE 'x'` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | blocked |
| Config / leaks | `SET memory_limit = '8GB'` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | blocked |
| Config / leaks | `PRAGMA version` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Config / leaks | `SELECT current_setting('allowed_paths')` | blocked | blocked by validator | Blocked: `current_setting` is not allowed; only `trips` and ordinary functions are available | ran |
| Config / leaks | `SELECT * FROM duckdb_settings()` | blocked | blocked by validator | Blocked: `duckdb_settings` is not allowed; only `trips` and ordinary functions are available | ran |
| Config / leaks | `SELECT * FROM pragma_version()` | blocked | blocked by validator | Blocked: `pragma_version` is not allowed; only `trips` and ordinary functions are available | ran |
| Config / leaks | `SELECT main.duckdb_extensions()` | blocked | blocked by validator | Blocked: `duckdb_extensions` is not allowed; only `trips` and ordinary functions are available | blocked |
| Runaway | `SELECT range(10000000000)` | runaway | engine error | Invalid Input Error: Lists larger than 2^32 elements are not supported | same |
| Runaway | `SELECT repeat('x', 2000000000)` | runaway | engine error | Out of Memory Error: failed to allocate data of size 2.0 GiB (48.0 KiB/953.6 MiB used) | same |
| Runaway | `FROM trips a, trips b WHERE a.fare_amount < b.fare_amount` | runaway | not run | passes the validator; Cancel / 30 s timeout stop it in the browser | same |
| Validator itself | `SELECT 1 AS x'); DROP TABLE trips; --` | blocked | blocked by validator | Syntax error: unterminated hexadecimal string literal at or near "x'); DROP TABLE trips; --" | blocked |
| Validator itself | `ＳＥＬＥＣＴ 1` | blocked | blocked by validator | Syntax error: syntax error at or near "ＳＥＬＥＣＴ" | blocked |
| Validator itself | `SELECT * FROM trірs` | blocked | blocked by validator | Blocked: `trірs` is not available; only `trips` can be queried | blocked |
| Validator itself | `DRОP VIEW trips` | blocked | blocked by validator | Syntax error: syntax error at or near "DRОP" | blocked |
| Validator itself | `SELECT 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa… (100022 chars)` | allowed | not blocked |  | same |
| Known fail-open | `SELECT version() AS v, current_database() AS db` | allowed | not blocked |  | same |
| Known false positive | `SELECT * FROM (PIVOT trips ON payment_type USING count(*))` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Known false positive | `SELECT * FROM generate_series(1, 3)` | blocked | blocked by validator | Blocked: `generate_series` is not allowed; only `trips` and ordinary functions are available | ran |
| Known false positive | `SELECT * FROM unnest([1, 2, 3])` | blocked | blocked by validator | Blocked: `unnest` is not allowed; only `trips` and ordinary functions are available | ran |
| Known false positive | `SELECT $$it's$$ AS s;` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |
| Known false positive | `SELECT $$a--b$$ AS s` | blocked | blocked by validator | Syntax error: unterminated dollar-quoted string at or near "$$a" | ran |
| Known false positive | `SELECT E'a\'b';` | blocked | blocked by validator | Blocked: only a single SELECT is allowed | ran |

84 rows: 54 blocked by validator, 0 blocked by lockdown only, 27 allowed and ran, 2 engine error, 1 not run

The statement check and the AST walk blocked every row marked `blocked` (54 rows: 48 attacks and 6 known false positives). No row reached the engine and was stopped by the lockdown alone. Without the validator, 24 of the 48 attack rows ran on the lockdown-only engine (for example `DROP VIEW trips`, `SELECT 1; DROP VIEW trips`, `query(chr(83) || 'ELECT 7')`, `SELECT * FROM 'trips.parquet'`).

## Golden results

Output of `npx tsx golden/compare.ts golden/out/*T*.json`, pasted unchanged below (the six reports from this run; the dev set has 13 questions written before the prompt, the holdout 8 questions written after the snippets were committed). Pass counts are out of 3 runs. No run was retried and no run hit a service error (`retried` and `outcome` fields in all six files).

## dev set

- none: dev-none-2026-11-06T134623.json · 3 run(s) · google/gemini-3.7-flash · fingerprint 012421da9476471f
- all: dev-all-2026-11-06T135035.json · 3 run(s) · google/gemini-3.7-flash · fingerprint 012421da9476471f
- top4: dev-top4-2026-11-06T135517.json · 3 run(s) · google/gemini-3.7-flash · fingerprint 012421da9476471f

| Question | Check | none | all | top4 |
| --- | --- | --- | --- | --- |
| tip-by-borough | exact | 0/3 | 3/3 | 3/3 |
| top-tip-payment | top1 | 3/3 | 3/3 | 3/3 |
| flex-fare-trips | exact | 3/3 | 3/3 | 3/3 |
| newark-pickups | exact | 3/3 | 3/3 | 3/3 |
| outside-nyc-pickups | exact | 3/3 | 3/3 | 3/3 |
| weekend-trips | exact | 3/3 | 3/3 | 3/3 |
| trips-per-day | exact | 3/3 | 3/3 | 3/3 |
| busiest-pickup-zone | top1 | 3/3 | 3/3 | 3/3 |
| fare-by-hour | exact | 3/3 | 0/3 | 3/3 |
| card-tip-rate | exact | 3/3 | 0/3 | 3/3 |
| median-trip-length | any_of | 2/3 | 0/3 | 2/3 |
| february-trips | refuse | 3/3 | 3/3 | 3/3 |
| month-over-month | refuse | 3/3 | 3/3 | 3/3 |
| **total runs passed** | | 35/39 | 30/39 | 38/39 |
| **questions passed (majority of runs)** | | 12/13 | 10/13 | 13/13 |

Flips (a question passes an arm when it passes a majority of its runs):

| From → to | fail→pass | pass→fail | Questions |
| --- | --- | --- | --- |
| none → all | 1 | 3 | +tip-by-borough, -fare-by-hour, -card-tip-rate, -median-trip-length |
| none → top4 | 1 | 0 | +tip-by-borough |
| all → top4 | 3 | 0 | +fare-by-hour, +card-tip-rate, +median-trip-length |

## holdout set

- none: holdout-none-2026-11-06T135934.json · 3 run(s) · google/gemini-3.7-flash · fingerprint 012421da9476471f
- all: holdout-all-2026-11-06T140125.json · 3 run(s) · google/gemini-3.7-flash · fingerprint 012421da9476471f
- top4: holdout-top4-2026-11-06T140344.json · 3 run(s) · google/gemini-3.7-flash · fingerprint 012421da9476471f

| Question | Check | none | all | top4 |
| --- | --- | --- | --- | --- |
| jfk-airport-pickups | exact | 3/3 | 3/3 | 3/3 |
| cash-share | exact | 3/3 | 3/3 | 3/3 |
| busiest-hour | top1 | 3/3 | 3/3 | 3/3 |
| weekday-avg-fare | any_of | 3/3 | 3/3 | 3/3 |
| jfk-dropoff-tip | exact | 0/3 | 3/3 | 3/3 |
| missing-passenger-count | exact | 3/3 | 3/3 | 3/3 |
| quietest-day | top1 | 3/3 | 3/3 | 3/3 |
| march-revenue | refuse | 3/3 | 3/3 | 3/3 |
| **total runs passed** | | 21/24 | 24/24 | 24/24 |
| **questions passed (majority of runs)** | | 7/8 | 8/8 | 8/8 |

Flips (a question passes an arm when it passes a majority of its runs):

| From → to | fail→pass | pass→fail | Questions |
| --- | --- | --- | --- |
| none → all | 1 | 0 | +jfk-dropoff-tip |
| none → top4 | 1 | 0 | +jfk-dropoff-tip |
| all → top4 | 0 | 0 | - |

## Golden run notes

Hand-written from the run logs, not part of the `compare.ts` output.

What the failing runs returned:

- `tip-by-borough`, `none`: `AVG(tip_amount) … GROUP BY pickup_borough` with cash trips included (3 of 3).
- `fare-by-hour`, `all`: added `WHERE fare_amount > 0` (3 of 3).
- `card-tip-rate`, `all`: returned the rate × 100 as a percentage (3 of 3).
- `median-trip-length`, `all`: returned distance and duration in two columns (3 of 3). In `none` and `top4` the one failing run did the same or filtered `trip_distance > 0`. The passing runs matched reading 1 (median distance).
- `jfk-dropoff-tip`, `none`: `AVG(tip_amount) … WHERE dropoff_zone = 'JFK Airport'` with cash trips included (3 of 3).

Which reading matched:

- `weekday-avg-fare` matched reading 1 (no fare filter) in `none` and `top4`, and reading 2 (`fare_amount > 0`) in `all`, in every run.

## Semantic correctness

### The problem

A query can run, return a clean table and answer a different question. The validator and the engine do not find this error. The user sees a correct-looking number.

### What the app does

| Part | What it does | Code |
| --- | --- | --- |
| Schema | The prompt gives each column with its type and a description. The description of each text column lists its exact labels, for example `'Flex fare'` and `'EWR'`. | `shared/schema.ts` |
| Rules | The prompt tells the model to write one `SELECT`, to state each assumption or filter in a one-sentence rationale, and to refuse a question that the table cannot answer. | `worker/prompt.ts` |
| Snippets | 23 hand-written snippets: 18 notes about traps in the data (for example, cash tips are not recorded) and 5 example questions with SQL. | `shared/snippets.ts` |
| Retrieval | The Worker ranks the snippets against the question with BM25 and adds the top 4 to the prompt. This is the `top4` arm. The UI always uses it (`DEFAULT_CONTEXT`). | `worker/retrieve.ts`, `shared/api.ts` |
| Refusal | For another month, another year or a question outside the data, the model returns `cannot_answer` with a reason. The UI shows the reason and runs no SQL. | `worker/prompt.ts`, `src/state.ts` |
| Visible answer | The UI shows the SQL, the rationale ("Why:") and the snippet IDs ("Context used:"). The user can edit the SQL and run it again. | `src/App.tsx` |
| Golden set | 21 questions with reference SQL. Most questions have a trap: a known way in which this data gives a wrong answer. The dev questions were written before the prompt. The holdout questions were written after the snippets were committed. | `golden/questions.ts`, `golden/holdout.ts` |

The golden runner compares each result with the reference result. It uses one of four checks:

| Check | A run passes when |
| --- | --- |
| `exact` | The result has the same number of rows and columns as the reference, and the same values after rounding to 2 decimal places. Row order and column order do not count. |
| `top1` | The first row of the result contains the first value of the first reference row. |
| `any_of` | The result passes `exact` against one of two or more references. The report records which reference matched. |
| `refuse` | The model returns `cannot_answer`. |

### What the results show

- **The snippets fixed one trap: cash tips.** The schema description of `tip_amount` says that cash tips are not recorded. But without snippets, the model included cash trips in both tip questions in every run (`tip-by-borough` 0/3, `jfk-dropoff-tip` 0/3). With `all` or `top4`, the model excluded cash trips in every run (3/3). The snippet gives an instruction (`payment_type <> 'Cash'`). The schema gives only a fact. We think this difference is the cause. We did not test it.
- **The other traps passed without snippets.** The traps for `'Flex fare'`, `'EWR'`, `'Unknown'` and `'N/A'`, weekend day numbers, a `NULL` passenger count, the JFK zone and the cash percentage passed 3/3 in all three arms. The schema labels and the rules were sufficient.
- **Refusal worked on the questions we wrote.** `february-trips`, `month-over-month` and `march-revenue` passed 3/3 in all three arms, also in `none`. The prompt rule and the `pickup_at` description were sufficient.
- **More context can change a correct reading.** On the dev set, `all` failed three questions that `none` and `top4` passed. In each case the SQL ran without an error, but the result had a different reading: fares filtered by `fare_amount > 0`, a percentage instead of a fraction, two medians in one row. We think the model applied notes to questions that they do not fit. We did not test this. For this reason the UI uses `top4`, not `all`.
- **An ambiguous question gets one answer.** `median-trip-length` and `weekday-avg-fare` each have two correct readings. Each run gave one reading. The arm changed which reading the model gave.
- **The holdout does not prove that retrieval helps.** On the holdout, `top4` and `all` each have 1 fail→pass flip over `none` and 0 flips back. A sign test needs a minimum of 6 one-way flips and none back to get p < 0.05. We set no threshold and claim no significance.

### What is not solved

- **Nothing checks a new question.** The golden set finds wrong answers only for the 21 questions that we wrote. For a different question, nothing compares the result with a correct answer.
- **Nothing checks the rationale.** The model writes the rationale and the SQL in the same answer. Nothing makes sure that the rationale agrees with the SQL. The rationale and the snippet IDs let a person find a wrong answer. They do not make the answer correct.
- **The retry fixes errors, not wrong answers.** The pipeline retries one time, and only when the validator rejects the SQL or DuckDB reports an unknown column or function (`shared/pipeline.ts`). A query that runs and answers the wrong question gets no retry.
- **The model does not ask back.** For an ambiguous question, the model gives one reading and does not ask which reading the user wants. The next step is to ask the model twice and show both results when they are different.
- **The snippets cover only the traps that we know.** For a trap that is not in a snippet, the app has no protection.
- **The dev results are not independent.** The dev questions existed when we wrote the snippets.
- **The holdout references were not checked for rounding.** The `exact` check rounds to 2 decimal places. We checked the dev references for values near a rounding boundary. We did not check the holdout references.
- **The sample is small.** Each result is 3 runs at `temperature: 0` with no pinned provider.

## Known failures

| Failure | What happens | Test that shows it |
| --- | --- | --- |
| The denylist fails open | A function not on the list passes the walk: `SELECT version() AS v, current_database() AS db` is allowed and runs. Only `query`, `query_table`, `current_setting` and the `duckdb_*` / `pragma_*` prefixes are denied. Files and network are still stopped by the lockdown. | `tests/attacks.ts` row "Known fail-open", run by `tests/validate.test.ts` (result: not blocked) |
| Statement-form `PIVOT` is rejected | `SELECT * FROM (PIVOT trips ON payment_type USING count(*))` is blocked as "only a single SELECT is allowed"; the serializer does not accept it. The prompt asks for `FROM trips PIVOT (…)`, which passes. | `tests/attacks.ts` "Known false positive" row; `tests/validate.test.ts` "syntax errors" case `PIVOT trips ON payment_type USING count(*)`; the must-pass standard `PIVOT` row |
| `generate_series` / `unnest` in `FROM` are rejected | They are `TABLE_FUNCTION`s, which the walk blocks, so valid queries that use them are refused. | `tests/attacks.ts` "Known false positive" rows `generate_series(1, 3)` and `unnest([1, 2, 3])` |
| `$$…$$` and `E'…'` strings with a trailing `;` or `--` inside | `stripTail` only knows `'…'` and `"…"`, truncates these, and the check fails closed. | `tests/attacks.ts` "Known false positive" rows `SELECT $$it's$$ AS s;`, `SELECT $$a--b$$ AS s`, `SELECT E'a\'b';` |
| Ambiguous questions get one reading | "What is the median trip length?" and "What is the average fare on weekdays?" are answered with one reading per run, and the reading changes with the context arm. | `golden/questions.ts` `median-trip-length`, `golden/holdout.ts` `weekday-avg-fare` (`any_of`); `matched` in `golden/out/*.json` |
| Runaway queries are stopped, not prevented | The cross join `FROM trips a, trips b WHERE a.fare_amount < b.fare_amount` passes the validator; Cancel or the 30 s timeout stop it in the browser. The golden runner has no timeout (PLAN.md Divergences). | `tests/attacks.ts` "Runaway" rows (result: not run / engine error); `tests/pipeline.test.ts` "reports a stopped query as stopped, not as an error"; phase 1 manual Cancel check |
| The wrapper renames duplicate columns and shifts line numbers | `SELECT 1 AS a, 2 AS a` comes back as `a, a_1`; error line numbers are one higher than in the user's SQL. | Phase 3 review probe; no automated test |
