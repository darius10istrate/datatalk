# Plain-English Questions over NYC Taxi Data

Ask a question about NYC yellow taxi trips in January 2024 and get the answer as a table. A Cloudflare Worker sends the schema and a few hand-written notes (never rows) to an LLM, which returns SQL and a one-line rationale. The browser checks the SQL, shows it, and runs it in DuckDB-WASM. You can edit the SQL and run it again without calling the LLM.

- `PLAN.md`: what is built and what is not, risks, assumptions, divergences from the plan.
- `VERIFICATION.md`: the validator attack table, golden-set results, known failures.
- `AI-USAGE.md`: AI tools used to build the app, and the model the app calls.

## Setup

Tested on Node.js 24.18.0. Internet is needed only during install and setup; after that the app's only network call is the Worker's call to OpenRouter.

```sh
npm install
npm run setup
npm run dev
```

Open http://localhost:5173. The status bar shows "Ready · 2,964,606 trips" once the data has loaded.

`npm run setup` downloads the TLC January 2024 file (50 MB, SHA-256 checked) and the zone lookup into `.cache/`, writes `public/data/trips.parquet` (13 columns, 2,964,606 rows, 43.9 MB), and downloads the DuckDB `parquet` and `json` extensions into `public/ext/`. It skips any step whose output already exists, so a failed download can be rerun.

**Clean-clone time:** about 1 min 45 s from `git clone` to "Ready" (clean-clone test #2, measured by hand on 2026-11-06).

### Keys

Copy `.env.example` to `.env` and fill it in:

| Key | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | An OpenRouter key. Without it, Ask shows "Couldn't reach the SQL service"; hand-written SQL still runs. |
| `OPENROUTER_MODEL` | Model ID. Default `google/gemini-3.7-flash` (the tested one). |
| `OPENROUTER_PROVIDER` | Optional. Pins one OpenRouter provider with no fallbacks. Leave empty to match the tested runs. |

Use `.env` only. **Do not create a `.dev.vars` file:** when it exists, the Cloudflare tooling ignores `.env`, and the Worker loses the key. The key stays in the Worker; Vite sends only `VITE_`-prefixed variables to the browser.

**Bindings:** none. `wrangler.jsonc` declares no KV, R2, D1, Vectorize or AI bindings; the Worker reads only the three variables above. Static assets are served by Workers Static Assets, with `/api/*` routed to the Worker first.

### Model tested

Every golden run in `VERIFICATION.md` used **`google/gemini-3.7-flash`** on OpenRouter at `temperature: 0`. The provider was **not pinned**: `OPENROUTER_PROVIDER` was empty, so OpenRouter chose any endpoint that honours the strict JSON schema (`provider.require_parameters: true`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | App and `/api/sql` on one Vite dev server |
| `npm test` | Schema, asset, check, retrieval, pipeline, app-state and validator tests; prints the attack table |
| `npm run test:worker` | Worker tests with a stubbed OpenRouter |
| `npm run typecheck` | TypeScript for app, Worker and Node code |
| `npm run golden -- --reference [--set dev\|holdout]` | Runs the reference SQL only (no LLM) |
| `npm run golden -- --set dev --context none,all,top4 --runs 3` | Golden run against a running `npm run dev`; writes `golden/out/*.json` |
| `npx tsx golden/compare.ts golden/out/*T*.json` | Pass counts per arm and the flip table |

## Example questions

These come from golden questions that passed 3 of 3 runs in the `top4` arm (the arm the UI uses). The answer is what those runs returned on the locked engine. Column names and wording vary between runs.

| Question | Answer |
| --- | --- |
| What is the average tip by pickup borough? | 8 rows, cash trips left out: EWR 13.47, Queens 10.17, N/A 9.20, … |
| Which payment type has the highest average tip? | Credit card, 4.17 |
| How many trips were paid with a Flex fare? | 140,162 |
| How many trips started on a weekend? | 760,460 |
| Which pickup zone had the most trips? | JFK Airport, 145,240 trips |
| Which hour of the day had the most pickups? | Hour 18, 212,788 trips |
| What percentage of trips were paid in cash? | 14.81 |
| Which day had the fewest trips? | 2024-01-07, 67,543 trips |
| How many trips were there in February 2024? | No SQL; "The data covers January 2024 only." |

The data is one month. Questions about other months get a short reason and no SQL.

## Deploying

The app runs locally only. To deploy it to Cloudflare Workers:

- Workers Static Assets cap each file at 25 MiB. `duckdb-eh.wasm` (34 MB) must load from jsDelivr instead of the bundle.
- `trips.parquet` (43.9 MB) must be split, for example with `COPY … TO … (FORMAT parquet, FILE_SIZE_BYTES '20MB')`, or served from R2.
- `public/ext/` is under the cap and deploys as is.
- `OPENROUTER_API_KEY` becomes a Worker secret (`wrangler secret put OPENROUTER_API_KEY`).
