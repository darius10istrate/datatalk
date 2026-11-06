import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../shared/api.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = join(ROOT, 'golden', 'out');

export const REPORT_NAME = /^(dev|holdout)-(none|all|top4)-.*\.json$/;

export type DatasetInfo = { version: string; trips: number; fingerprint: string };

export type ReportQuestion = { id: string; check: string; passes: number };

export type GoldenReport<Question extends ReportQuestion = ReportQuestion> = {
  set: string;
  arm: Context;
  runs: number;
  date: string;
  model_configured: string;
  models_served: string[];
  provider: string;
  dataset: DatasetInfo;
  results: Question[];
};
