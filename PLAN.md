# Plain-English Questions over NYC Taxi Data

A user asks a question in plain English. A Cloudflare Worker sends schema + snippets (never rows) to an LLM for SQL and a rationale. The browser checks the SQL and runs it in DuckDB-WASM; the user can edit and re-run it. Local only, cloned and running in under ten minutes.

## 1. What I'm building

- **SPA** (React + TS): question box, editable SQL (CodeMirror), rationale, snippets used, results table, and every loading, error and empty state.
- **Worker** `POST /api/sql`: BM25 picks the top 4 of 15–25 hand-written snippets. OpenRouter returns strict JSON: `sql` + `rationale`, or `cannot_answer` + `reason`. Model `openai/gpt-oss-120b`; `anthropic/claude-haiku-5.5` is one env var away.
- **Data:** NYC yellow taxi, January 2024 only (other months → `cannot_answer`). `npm run setup` writes 2,964,606 decoded rows (43.9 MB Parquet), mounted in the browser as a view.
- **Validator:** `json_serialize_sql(?::VARCHAR)` on the raw **and** the wrapped SQL, then a generic AST walk: one statement, only `trips` or an unqualified CTE, no `TABLE_FUNCTION`, no denylisted function. Then a locked engine, Cancel and a 30 s timeout.
- **One pipeline** (ask → validate → wrap → run → one coded retry) for the UI and golden runner, on DuckDB-WASM 1.32.0 everywhere. The Worker writes the retry text, so no errors or values reach the LLM.

## 2. What I'm deliberately not building

- **Out:** deploying (wasm and Parquet exceed the 25 MiB asset cap); sign-in, saved queries, charts, chat history, multi-step questions; more datasets or months; Vectorize, Workers AI, Ollama; an LLM judge.
- **Stretch, only once verification is done:** "Ask it twice", reusing the golden compare code.
- **Never cut:** validator + attack suite, golden runs, `VERIFICATION.md`, clean-clone test.
- **Cut order if the clock runs out** (lowest marks first): "Ask it twice" → Worker tests → CodeMirror (use a textarea) → holdout at 1 run → all snippets instead of BM25 → drop the holdout. **Checkpoints override the order:** at 3:25, if the Worker and prompt are unfinished, switch to all snippets. At 4:05, if the UI is unfinished, use the textarea.

## 3. Riskiest parts and how I find out early

**Riskiest: SQL that runs but answers the wrong question**, because it fails silently. Reference SQL for ~12 dev questions, with traps (cash tips, Flex fare, non-January months), is written in hour 2, **before any prompt**. The first golden run (~3:25, once the Worker works) shows pass counts against no context. Then snippets freeze and an 8-question holdout is written: the one result I cannot tune.

| Other risks (evidence) | Earliest cheap check |
| --- | --- |
| Validator bypass (`query()`, `system.main.*` pass naive checks) | Attack cases written as failing tests before `validate.ts` |
| Runaway query (cross join 90 s+ under a 1 GB limit) | Cancel + timeout built in hour 1 (`cancelSent()` stopped it in 2 ms) |
| Test DuckDB ≠ browser DuckDB (node-api 2.0 AST differs) | Test asserts `version()` = v1.4.3 in Node and browser |
| Provider ignores the JSON schema (6 of 27 endpoints) | `require_parameters: true`; malformed-JSON test |
| Ten-minute setup (~85 MB of downloads) | Clean clone after the first hour and again at the end |

## 4. How I'll know it works

- **Setup:** `npm install && npm run setup && npm run dev` on a fresh clone reaches "Ready · 2,964,606 trips" in under 10 min, timed twice.
- **Safety:** `npm test` prints the attack table: "blocked by validator", "lockdown only" or "**not blocked**" (each one a known failure in `VERIFICATION.md`). `trips` survives; must-pass queries (`WITH`, `QUALIFY`, standard `PIVOT`, trailing `;`) run.
- **Correctness:** `npm run golden` runs each question through the shared pipeline: 3 arms (none / all / top-4) × 3 runs, dev and holdout apart, with `exact` / `top1` / `any_of` / `refuse` checks. It prints pass counts out of 3 and a flip table. **Retrieval** is judged on holdout flips: **no fixed threshold, no significance claim** (p < 0.05 needs ≥6 flips, none back).
- **UI:** a hand walk of every state in §1. Edit + Run makes no `/api/sql` call.
- **Honesty:** `VERIFICATION.md` states the evidence's limits and ≥3 known failures (denylist fails open, statement `PIVOT` refused, one reading of ambiguous questions).

## 5. Assumptions

- **"Rows of data" means values read from the dataset.** Labels copied by hand from the TLC dictionary (`'Flex fare'`) are documentation, so snippets may name them.
- **"Retrieves relevant context" is met by keyword retrieval** (BM25) over hand-written snippets in the Worker. (Vectorize has no local simulation.)
- **"SELECT only" includes** `WITH`, `DESCRIBE` / `SUMMARIZE trips` and standard `FROM trips PIVOT (…)`, not `PIVOT trips ON …`.
- **Payment codes follow the current TLC dictionary,** where 0 = Flex fare. Card and Flex fare trips record tips; cash tips average $0.002.
- **Internet only for install and setup;** then the only call is Worker → OpenRouter.
- **A Parquet view, not a table** (44 KiB vs. 526 MiB): pruning pays off in memory, not download.
- **Threat model:** the LLM's output (wrong or steered) and an assessor probing the validator via the UI, not a user's own devtools.
