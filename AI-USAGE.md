# AI Usage

## Tools used to build

- **Claude Code (Claude Opus 5.5, medium effort):** wrote all the code, ran the research subagents and the adversarial design reviews, and did one code review per phase (`/code-review`).
- **Kimi K2.7:** the second code review per phase (`/review`), nothing else.
- **Skills:** `rpi` (humanlayer, research-plan-implement) for research → design → outline → implementation one phase at a time; `design-plan` for a visual design doc.

## Handed over and kept

- **Handed over wholesale:** all code. None was written by hand.
- **Kept:** the design calls (threat model, view over Parquet, cut order), the hand check of every golden reference answer before any prompt existed, and every review decision. For each phase I checked both reviewers' findings against the code and the design, dropped the false positives, merged the rest and had them fixed.

## Rejected or rewritten

- **A function allowlist** in the validator: it refuses harmless functions. The denylist failing open is a known failure instead.
- **`''`-escaping the SQL** to call `json_serialize_sql`: replaced by a bound `?::VARCHAR`.
- **A fatal start-up schema check:** replaced by a test and a dev banner, so hand-written SQL still runs.
- **Rewording a holdout question** after it had run: refused; it would re-score a result I cannot tune.

## Confidently wrong, and how I caught it

Kimi's phase 3 review said `silent: false` in `vitest.config.ts` does nothing and should go. Checking Vitest 5.1.0's source showed the opposite: in an AI-agent environment Vitest picks the `minimal` reporter, which hides the output of passing tests unless `silent` is set. Without the line, `npm test` stops printing the attack table that `VERIFICATION.md` is built from. The line stayed.

## Model the app calls

Only the Worker calls OpenRouter: `google/gemini-3.7-flash` (`OPENROUTER_MODEL`), `temperature: 0`, strict JSON schema, `provider.require_parameters: true`, provider not pinned. It sends the schema, up to 4 hand-written snippets and the question; on a retry, the previous SQL and a fixed error code. Never rows, results or raw DuckDB errors.
