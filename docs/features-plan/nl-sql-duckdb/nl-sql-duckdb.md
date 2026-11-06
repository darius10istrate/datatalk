# Plain-English Questions over NYC Taxi Data

`2026-11-05` · A local web app: a user asks a question in plain English, a Worker turns it into SQL with an LLM, and the browser checks and runs that SQL in DuckDB-WASM · No change to: nothing exists yet (the repo holds only `skills-lock.json`; no code to cite) · Covers: FR-1 – FR-15 (FR-16 stretch)

Sources: `.agents/artifacts/nl-sql-duckdb/01-request`, `03-research`, `04-design-discussion` (rev. 21:30, questions 1–12), `07-structure-outline`. FR ids come from the request and the brief items `04` quotes.

## 1. Requirements

| Id | Its text, quoted | What this design does about it |
| --- | --- | --- |
| FR-1 | "Single-page app … an input box, the generated SQL, a results table, and sensible loading, error and empty states." | React SPA: question box, CodeMirror SQL editor, results table. Eleven named states (§9). |
| FR-2 | "Cloudflare Worker exposing the APIs this use case needs." | One endpoint, `POST /api/sql`, served by the same `vite dev` through `@cloudflare/vite-plugin`. |
| FR-3 | "Worker … retrieve dataset context (schema, not rows)" | The Worker owns the schema module and BM25-retrieves the top 4 of 15–25 hand-written snippets. |
| FR-4 | "Dataset loaded into the browser, about 5–50 MB … Parquet if possible." | NYC yellow taxi, January 2024: 2,964,606 trips, 43.9 MB zstd Parquet, mounted as a **view** (44 KiB vs. 526 MiB for a table). |
| FR-5 | "Validator that only lets read queries through (SELECT only)." | `json_serialize_sql(?::VARCHAR)` on the raw and wrapped SQL, a generic AST walk, a denylist, then a locked engine. |
| FR-6 | "The LLM never receives rows of data." | Prompt = schema + snippets + question. Retry text is written by the Worker from a fixed `code` + a checked identifier. |
| FR-7 | "The generated SQL is visible in the UI, and the user can edit and re-run it." | Editable SQL. **Run** re-validates and re-runs; it never calls the LLM. |
| FR-8 | "A reviewer can clone the repo and have it running locally in under ten minutes." | `npm install && npm run setup && npm run dev`. Clean-clone test at the end of slice 1 and slice 7. |
| FR-9 | Brief: "SQL and a one-line rationale" | Strict JSON union `{kind:'sql', sql, rationale} \| {kind:'cannot_answer', reason}`. Rationale shown under the SQL. |
| FR-10 | Brief: "retrieval demonstrably improves the SQL over no context" | Golden runner with three arms (none / all / top-4), 3 runs each, on a dev set and an 8-question holdout. |
| FR-11 | Brief: `PLAN.md` as the first commit, 1–2 pages | Slice 0. A Divergences section grows during the build. |
| FR-12 | Brief: `VERIFICATION.md`, read "most carefully" | Attack table, golden pass counts and flip table, limits of the evidence, ≥3 known failures. |
| FR-13 | Brief: `README.md` with setup | Setup, `.env` keys, model ID **and provider** tested, 5–10 example questions, "Deploying" note. |
| FR-14 | Brief: `AI-USAGE.md`, half a page | A running log, started in slice 0. |
| FR-15 | Brief: "secrets in bindings" | `OPENROUTER_API_KEY` only in `.env` / Worker env; repo ships `.env.example`. |
| FR-16 | Brief (stretch): one extension, only once the above is solid | "Ask it twice", reusing the golden compare code, only if verification is done. |

## 2. The problem

- Someone with no SQL wants answers from a dataset.
- LLMs write SQL that **runs but answers the wrong question**. Without reference answers, nobody sees it.
- LLM SQL (or a crafted question) can be hostile. The engine lockdown alone lets `COPY … TO 'trips.parquet'` and `query(chr(83)||'ELECT 7')` through (`04` Q4).
- The schema cannot carry business rules: cash tips are not recorded, code 0 is Flex fare with real tips, data covers January only.
- The test DuckDB and the browser DuckDB must be the same version: node-api 2.0 serializes the AST differently from 1.4.3.
- Static Assets cap files at 25 MiB; the wasm (34 MB) and data (43.9 MB) exceed it.

## 3. The goal

- Ask → see SQL, a rationale and the snippets used → see a table. Local, no Cloudflare account.
- Every query passes the validator on both raw and wrapped strings, then runs on a locked engine with Cancel and a 30 s timeout.
- Retrieval is measured against no context and all snippets, on a dev set and an untuned holdout.
- Every slice leaves something to verify and explain (verification + reasoning = 50% of marks).

Non-goals:

- Deploying (README note only), sign-in, saved queries, charts, chat history, multi-step questions.
- More datasets or months; cross-month questions get `cannot_answer`.
- Vectorize, Workers AI, Ollama, an LLM judge.
- Defending a user's own devtools tampering (threat model, `04` Assumptions).

## 4. Where things live

| Module | What it does | Public interface it gains or changes | New / changed / removed |
| --- | --- | --- | --- |
| `shared/schema` | Table, 13 columns, types, value-free descriptions | `TABLE`, `COLUMNS`, `ddl()` | New |
| `shared/lockdown` | Engine settings applied after load | `LOCKDOWN: string[]` | New |
| `shared/snippets` | 15–25 hand-written snippets, frozen before the holdout | `SNIPPETS: {id, tags, text}[]` | New |
| `shared/validate` | Pure walk over the serialized AST | `checkAst(json) → Rejection \| null`, `message(r)` | New |
| `shared/wrap` | Strip the tail, wrap with the row cap | `stripTail(sql)`, `wrap(body)` | New |
| `shared/api` | Request/response types, retry codes, name regex | `SqlRequest`, `SqlResponse`, `RetryCode` | New |
| `shared/pipeline` | Ask → validate → wrap → run → retry once; used by UI and golden runner | `askAndRun()`, `validateAndRun()`, `Adapters` | New |
| `worker/` (index, retrieve, prompt, openrouter) | `/api/sql`: check request, retrieve, prompt, call OpenRouter, map errors, log | `POST /api/sql` (§7) | New |
| `src/db` | Instantiate, mount view, lock, run with send/cancel | `init(onProgress)`, `runQuery(sql, signal)` | New |
| `src/components` | StatusBar, QuestionBox, SqlEditor, ResultsTable | React components on one `AppState` | New |
| `scripts/setup` | Raw TLC + zones → `trips.parquet`; extensions → `public/ext` | `npm run setup` | New |
| `golden/` | Dev questions, holdout, checks, runner, compare | `npm run golden [--set] [--context] [--runs] [--reference]` | New |
| `tests/` | Node engine, schema, validator + attacks, checks, retrieval, Worker | `npm test`, `npm run test:worker` | New |
| Docs | `PLAN`, `README`, `VERIFICATION`, `AI-USAGE` | — | New |

## 5. Reuse

| Piece | What it does | Comes from | Shared or owned here |
| --- | --- | --- | --- |
| SPA + Worker layout | `src/` + `worker/`, `run_worker_first: ["/api/*"]` | Cloudflare `react-starter-template` | Scaffolded, then owned |
| DuckDB-WASM 1.32.0 (DuckDB 1.4.3) | Browser engine and Node blocking build for tests and golden | `@duckdb/duckdb-wasm`, exact pin | Shared (npm) |
| `@duckdb/node-api` 1.4.x | Writes `trips.parquet` in setup only | npm | Shared |
| `json_serialize_sql` | DuckDB's own parser; serializes SELECT only | `json` extension, served locally | Shared |
| `parquet`, `json` extensions | Loaded from the app's origin via `custom_extension_repository` | extensions.duckdb.org, fetched by setup | Shared |
| CodeMirror | Highlighting, schema completion, `Mod-Enter` | `@uiw/react-codemirror` + `@codemirror/lang-sql` | Shared |
| OpenRouter | Chat API with strict `json_schema`, `require_parameters` | openrouter.ai | External |
| BM25 | Keyword retrieval over snippets | ~40 lines, no dependency | Owned |
| `pipeline` / `validate` | Same steps in browser and golden runner | `shared/` | Owned, shared in-repo |
| Vitest + `@cloudflare/vitest-pool-workers` | Tests; Worker tests stub `fetch` | npm | Shared |

## 6. Saving

No server-side database. Local, single user.

| Data | Table.column | Written by | Read by | Tenant column / RLS / index |
| --- | --- | --- | --- | --- |
| Raw TLC + zones | `.cache/*` (gitignored), SHA-256 `c4d59da7…0510` checked | setup | setup | N/A — local files |
| Prepared dataset | `public/data/trips.parquet` (gitignored), 13 cols, Jan only | setup (skips if present; prints rows + content fingerprint) | SPA fetch, Node engine | N/A |
| Extensions | `public/ext/v1.4.3/wasm_eh/*` (gitignored) | setup | Browser + Node DuckDB | N/A |
| View | `trips` over the registered buffer | `init()`, before the lock | `runQuery` | N/A — `allowed_paths=['trips.parquet']`, `lock_configuration` |
| Secrets | `.env`: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_PROVIDER` | Dev / reviewer | Worker env | Gitignored |
| Golden output | `golden/out/<set>-<arm>-<date>.json` (gitignored) | golden runner | `compare.ts` → `VERIFICATION.md` | N/A |

Delete behavior: reload drops the view; deleting `trips.parquet` makes the next `npm run setup` rebuild it · Migration and backfill: N/A — greenfield. Output Parquet is not byte-stable, so identity is the raw hash + content fingerprint.

## 7. Contracts

| Endpoint or tool | Input | Output | Errors | Breaks anything existing? |
| --- | --- | --- | --- | --- |
| `POST /api/sql` | `{ question ≤ 500, context?: none\|all\|top4 (default top4), previous_sql? ≤ 4,000, problem?: {code: RetryCode, name?} }` | 200 `{kind:'sql', sql, rationale, snippet_ids, model}` or 200 `{kind:'cannot_answer', reason, snippet_ids, model}` | 400 `bad_request` (caps, unknown code, name fails `^[A-Za-z_][A-Za-z0-9_]{0,63}$`) · 500 `missing_key` (names `OPENROUTER_API_KEY`) · 502 `bad_model_output` / `upstream` · 504 `upstream` (20 s timeout) | No — new |
| OpenRouter call (outbound) | DDL + descriptions + 0/4/all snippets + question [+ retry template] · `temperature: 0`, pinned provider, `require_parameters: true` | Strict JSON union | Non-2xx, timeout, schema mismatch → 502/504 | No |
| `npm run setup` | Network to TLC CDN + extensions.duckdb.org | Parquet, extensions, row count, fingerprint | Hash mismatch / download fail → non-zero exit; `DESCRIBE` ≠ schema → fail | No |
| `npm run golden` | `--set dev\|holdout`, `--context`, `--runs`, `--reference`; needs `npm run dev` | Pass counts per question × arm, snippet ids, retried, header (model, provider, date, fingerprint); JSON file | API unreachable → abort with message | No |

`RetryCode` = `not_select | multi_statement | table_not_allowed | function_blocked | unknown_column | unknown_function | syntax`. Raw DuckDB text never crosses the wire (FR-6).

## 8. Flows

Happy path:

1. Load: select bundle → `SET custom_extension_repository` = origin `/ext` → fetch `trips.parquet` (progress) → `registerFileBuffer` → `CREATE VIEW trips` → `LOAD parquet, json` → `LOCKDOWN` (autoload off, `memory_limit='1GB'`, `allowed_paths`, `enable_external_access=false`, `lock_configuration=true`). Status: "Ready · 2,964,606 trips". Dev only: drift banner if `DESCRIBE` ≠ schema.
2. User asks. Ask is disabled while busy; old SQL and results stay visible.
3. Worker: check request → BM25 top-4 → prompt → OpenRouter → union + `snippet_ids` → log one line.
4. Browser: `stripTail` → `wrap` → `json_serialize_sql(?::VARCHAR)` on **both** → `checkAst` on both.
5. `conn.send(wrapped)`; Cancel or 30 s → `cancelSent()`. Read Arrow batches to 1,001 rows; BigInt → string.
6. Show ≤1,000 rows, row count, ms, rationale, "Context used".
7. Edit → **Run** / `Mod-Enter` → steps 4–6. No LLM call.

Retry (model SQL only, once): rejection or parser/binder error → map to `{code, name}` → `POST /api/sql {question, previous_sql, problem}` → Worker writes the message from a template + column names → steps 4–6. Second failure is shown.

Failure paths:

| What fails | What the user sees | What is left behind |
| --- | --- | --- |
| wasm / data / extension load | Load error in the status bar; Ask disabled | Nothing; reload retries |
| Worker unreachable, 502, 504 | "Couldn't reach the SQL service"; editor still runs hand-written SQL | Previous SQL and results |
| 500 `missing_key` | Message naming `OPENROUTER_API_KEY` and `.env` | — |
| `cannot_answer` | The model's short reason, no SQL | Previous results |
| Validator rejects | Editable SQL + plain reason ("Blocked: `read_csv` reads files; only `trips` is available") | Results cleared; nothing ran |
| Parser/binder error (model SQL) | One silent retry, then the DuckDB message under the editor | — |
| Other query error (e.g. conversion) | DuckDB message under the editor; no retry (may quote values) | Results cleared |
| Cancel / 30 s timeout | "Cancelled" / "Query stopped after 30 s"; SQL editable | Engine stays loaded |
| OOM (e.g. huge `repeat()`) | Query error at ~953 MiB | Engine survives (tested) |
| 0 rows / > 1,000 rows | "No rows matched" / "Showing the first 1,000 rows" | — |
| Schema drift (dev) | Banner naming mismatched columns | Queries still run |

## 9. Screens

| Screen | Prototype | States: empty / loading / error / no access | Design-system parts |
| --- | --- | --- | --- |
| Main (only): status bar, question box, SQL panel (editor, "✓ read-only" or reason, Run/Cancel, rationale, context used), results table | ASCII mock in `04` Desired End State | Empty: "No rows matched" · Loading: progress, Ask disabled · Asking: spinner, old SQL/results kept · Running: timer + Cancel · Error: rejected / query error / service down / cannot answer / cancelled / timed out · Truncated · Drift banner (dev) · No access: N/A — no auth | None — plain CSS, CodeMirror (textarea fallback), HTML table |

## 10. Who can do what

One human role (local user) and one untrusted actor (LLM output). "RLS" here means the engine lockdown.

| Role | Action | Allowed | Enforced in: UI / API / RLS |
| --- | --- | --- | --- |
| User | Ask a question | When Ready and not busy | UI / API (400 caps) |
| User or LLM | Run a single SELECT on `trips` (incl. `memory.main.trips`) or CTEs, `DESCRIBE`/`SUMMARIZE trips`, standard `PIVOT` | Yes | Validator |
| User or LLM | Write: `DROP`, `CREATE`, `INSERT`, `COPY`, `ATTACH`, `EXPORT`, `SET`, `PRAGMA` | No | Validator (not a SELECT) / lockdown partial |
| User or LLM | Files or URLs, any `TABLE_FUNCTION`, `query`, `query_table`, `current_setting`, `duckdb_*`, `pragma_*`, system catalogs | No | Validator walk + denylist / lockdown (files, network) |
| User or LLM | Change config or load extensions | No | Lockdown (`lock_configuration=true`) |
| Client | Supply or alter the schema or retry text | No | API (Worker owns schema; retry = code + checked name) |
| LLM | See rows, values, stats, results, raw errors | No | API (prompt builder) |
| Reviewer | Run tests and golden set | Yes | — |

## 11. When things go wrong

| Risk (retry, double submit, race, timeout, partial write) | What happens | How it is handled |
| --- | --- | --- |
| Double submit on Ask / Run during a query | Overlapping requests or queries | Ask and Run disabled while busy; Cancel shown |
| Runaway query (cross join ran 90 s+) | Tab busy | `send()` + Cancel + 30 s `cancelSent()` (stopped in 2 ms, tested) |
| Oversized allocation | Could kill the engine | `memory_limit='1GB'`; fails cleanly at 953.6 MiB (tested) |
| OpenRouter slow or down | No SQL | 20 s timeout → 504; hand-written SQL still works |
| Provider ignores the schema | Malformed JSON | `require_parameters: true`; otherwise 502 `bad_model_output` (stub test) |
| Retry loop | Repeated LLM calls | Exactly one retry, model SQL only, never on edits |
| Validator injection (`')` breakout) | SQL runs inside the validator | Bound `?::VARCHAR`; injection test leaves `trips` intact |
| `stripTail` mistakes, wrapper break-out | Bypass or broken SQL | Raw **and** wrapped both validated; a bad strip fails closed |
| Denylist fails open | Unlisted function passes | Lockdown backstop for files/network; known failure with a test |
| `COPY … TO 'trips.parquet'` breaks the view | Data gone until reload | Statement check rejects `COPY`; `query('COPY…')` refuses non-SELECT |
| Non-deterministic model | Golden flips | `temperature: 0`, pinned provider, 3 runs; report counts |
| Partial write | N/A — no persistent store | — |

## 12. Size and speed

- Data: 2,964,606 rows, 43.9 MB, fetched once per page load; view = 44 KiB DuckDB memory + 44 MB buffer.
- Engine: `duckdb-eh.wasm` 34 MB, served from `node_modules` on localhost.
- Query speed (Chromium, view): avg tip by borough 37 ms; `ORDER BY … LIMIT 10` 65 ms.
- Results: 1,001 fetched, 1,000 shown; no virtualization.
- Editor: ~160 KB gzipped.
- Prompt: ~13 columns + 4 snippets ≈ 1–2k tokens; ~$0.0002/call on `gpt-oss-120b`. Full golden (180 calls) < $0.05.
- Setup: ~50 MB TLC + 31 MB npm tarball + 3.8 MB extensions; clean clone timed twice.
- Golden: under a minute per arm, so it can run live in the follow-up.

## 13. Knowing it works

- Worker: one JSON line per `/api/sql` call — model, provider, latency, tokens, `snippet_ids`, outcome code, `retried`, context arm. Never the key.
- `npm test`: `version()` is `v1.4.3`; `DESCRIBE` == schema; every attack row is "blocked by validator", "blocked by lockdown only" or "**not blocked**"; must-pass queries run.
- `npm run golden`: pass counts out of 3 per question × arm, dev and holdout apart, flip table; header with model, provider, date, fingerprint.
- Signs it broke: any unexpected "not blocked" row; top-4 below none on the holdout; drift banner or schema test failure; rising `bad_model_output` / `upstream` in the log; clean clone over 10 min.

## 14. Functions and tools

| Function or tool | What it does |
| --- | --- |
| `npm run setup` | Downloads + hash-checks raw data, decodes codes (0 = Flex fare), joins zones, keeps January, writes zstd Parquet, fetches extensions; skips done steps |
| `init(onProgress)` | Instantiates DuckDB, mounts the view, loads extensions, applies `LOCKDOWN` |
| `runQuery(sql, signal)` | `send`, cancel on signal or 30 s, read ≤1,001 rows, BigInt → string |
| `stripTail` / `wrap` | Remove trailing `;`/comments/whitespace; `SELECT * FROM (\n…\n) LIMIT 1001` |
| `checkAst(json)` | One statement; `BASE_TABLE` = `trips` or unqualified CTE; no `TABLE_FUNCTION`; no denylisted function; generic walk |
| `validateAndRun(sql)` | Serialize raw + wrapped → `checkAst` both → `runQuery`; used by Run |
| `askAndRun(question)` | Ask → `validateAndRun` → map error to `{code, name}` → retry once |
| `retrieve(question, k)` | BM25 over snippet words + tags |
| `buildPrompt` / `retryMessage(code, name)` | Schema + snippets + question; retry text from template + column names |
| `callOpenRouter` | Strict `json_schema`, `require_parameters`, pinned provider, `temperature: 0`, 20 s timeout; parses the union |
| `checks` (`exact` / `top1` / `any_of` / `refuse`) | Compare model result to reference(s); `any_of` records which reading won |
| `golden/run` / `golden/compare` | Run sets × arms × runs through `pipeline`; pass counts and flip table |

## 15. Options considered

| Option | Pro | Con | Chosen, and why |
| --- | --- | --- | --- |
| Local only vs. deploy | One load path, no account | No URL | **Local** — brief asks for 10-min local setup |
| `postinstall` vs. `npm run setup` vs. commit Parquet | Automatic / visible + rerunnable / no network | Hidden 50 MB / one more command / license, size | **`npm run setup`** |
| Table vs. Parquet view | Table drops the file | 526 MiB vs. 44 KiB | **View** — statement check already blocks `COPY` |
| Client `DESCRIBE` vs. Worker-owned schema | — | Client could alter the prompt | **Worker owns it**; drift fails a test |
| String-escaped vs. bound `?::VARCHAR` | — | Own an escaping rule | **Bound** — plain `?` throws in 1.32.0 |
| Function allowlist vs. denylist + lockdown | Fails closed | Refuses `string_agg`, windows | **Denylist + generic walk**; weak spot stated |
| Known-field walk vs. generic walk | Simpler | Field names change between versions | **Generic walk** |
| Free-text `problem` vs. coded retry | Richer hint | Leaks values into the prompt | **Coded retry**, Worker writes the text |
| node-api 2.0 vs. WASM Node build in tests | Faster API | Different AST | **WASM 1.32.0 everywhere** |
| Vectorize vs. BM25 vs. all snippets | Semantic | No local sim / ties | **BM25 top-4**; "all" is a measured arm |
| LLM judge vs. reference SQL | Covers unwritten questions | Shares blind spots | **Reference SQL written first** |
| No holdout vs. 8 vs. 20 questions | Fast / ~25 min / sign test | Tuned only / small / ~50 min | **8-question holdout** after snippets freeze |
| Textarea vs. CodeMirror | 0 KB | ~160 KB | **CodeMirror**; textarea is cut #3 |

## 16. Today vs. after

| | Today | After |
| --- | --- | --- |
| Repo | `skills-lock.json`; not git | Git; commit 1 = `PLAN.md` alone |
| Data | None | `npm run setup` builds `trips.parquet`; browser mounts a view |
| API | None | `POST /api/sql` with typed errors and a log line |
| Safety | — | Raw + wrapped AST check, denylist, lockdown, attack suite |
| Context | — | Worker-owned schema + BM25 snippets; no rows |
| Proof | — | Dev + holdout golden × 3 arms × 3 runs, attack table, known failures |
| Docs | Research in `.agents/` | `PLAN`, `README`, `VERIFICATION`, `AI-USAGE` |

## 17. Slices

Timeboxes from `04` Build Order; each slice ends with a commit, a passing check and an `AI-USAGE.md` line.

| # | What it delivers | Depends on | Done when |
| --- | --- | --- | --- |
| 0 | `git init`; `PLAN.md` alone as commit 1; `AI-USAGE.md` stub, `.gitignore` (FR-11, FR-14) · 0:00–0:25 | — | `git log --stat --reverse` shows `PLAN.md` alone first |
| 1 | Scaffold, `npm run setup`, schema + lockdown, view, textarea + Run + Cancel + table, Node engine, schema test; clean clone #1 (FR-4, FR-8) · 0:25–1:15 | 0 | "Ready · 2,964,606 trips"; no request to extensions.duckdb.org; cross join cancels; `version()` = v1.4.3 |
| 2 | Dev golden set (~12) with reference SQL and checks; runner `--reference` (FR-12) · 1:15–1:45 | 1 | Every reference runs on the locked Node engine before any prompt exists |
| 3 | Attack suite (failing first), `validate` + `wrap`, wired into the browser run path (FR-5) · 1:45–2:25 | 1 | `npm test` prints the attack table; browser shows reasons for `DROP VIEW`, `read_csv` |
| 4 | Snippets, BM25, prompt, OpenRouter, `/api/sql` with errors + log, `pipeline` with retry, Worker tests; golden model mode (FR-2, FR-3, FR-6, FR-9, FR-15) · 2:25–3:25 | 2, 3 | `curl` returns SQL with the cash-tip snippet; first `npm run golden` result |
| 5 | UI loop: Ask, CodeMirror, rationale, context used, every state (FR-1, FR-7) · 3:25–4:05 | 4 | Hand walk of the state table; edit + Run makes no `/api/sql` request |
| 6 | Freeze snippets; 8-question holdout; 3 arms × 3 runs on both sets; `compare`; `VERIFICATION.md` (FR-10, FR-12) · 4:05–4:45 | 4 (5 for UI checks) | Snippets commit precedes holdout commit; six output files; every number traces to output |
| 7 | README, Divergences, `AI-USAGE.md`; clean clone #2 (FR-8, FR-13) · 4:45–5:00 | 6 | Fresh clone → Ready in under 10 min, time recorded |
| 8 | Stretch: "Ask it twice" on `compare` (FR-16) | 6 | Only started once 6 is done |

Cut order: Ask it twice → Worker tests → CodeMirror → holdout at 1 run → all snippets → drop holdout. Checkpoints: **3:25** slice 4 unfinished → all snippets; **4:05** slice 5 unfinished → textarea.

## 18. Rollout and rollback

- Flag: no. `context` is a measurement option, not a feature flag.
- Deploy order: N/A — one `vite dev` serves SPA + Worker. `npm install` → `npm run setup` → `npm run dev`.
- Undo: `git revert` per slice; model swapped via `OPENROUTER_MODEL` / `OPENROUTER_PROVIDER` · Cannot be undone: commit order once pushed — `PLAN.md` alone first, snippets before holdout.

## 19. Risks

| Risk | How likely | How bad | Mitigation |
| --- | --- | --- | --- |
| Semantically wrong SQL that runs | High | High | Reference SQL first, trap questions, rationale + snippet ids shown, holdout |
| Validator bypass | Medium | High | Attack tests first; raw + wrapped; generic walk; lockdown column |
| Test DuckDB ≠ browser DuckDB | Low (pinned) | High | `version()` test in Node and browser |
| Node build can't load local extensions | Unknown | Medium | First check of slice 1; fallback recorded in Divergences |
| `gpt-oss-120b` too weak | Medium | Medium | First golden run decides; `anthropic/claude-haiku-5.5` one env var away |
| Statement-form `PIVOT`, `generate_series`/`unnest` refused | Certain | Low | Prompt asks for standard form; known failures |
| Ambiguous question gets one reading | High | Medium | `any_of` check; rationale shown; "Ask it twice" next |
| Setup over 10 min | Low | High | Clean clone after slice 1 and 7 |
| Timebox overrun (slice 4 most likely) | Medium | High | Cut order + 3:25 / 4:05 checkpoints |

## 20. Open questions

- None. `04` settled questions 1–12; the error statuses, 20 s upstream timeout and Worker log line were settled on 2026-11-05 while writing this doc.
