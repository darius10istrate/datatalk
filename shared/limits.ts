import type { StopReason } from './pipeline.ts';

export const QUERY_TIMEOUT_MS = 30_000;

export const STOP_MESSAGES: Record<StopReason, string> = {
  cancelled: 'Cancelled',
  timeout: `Query stopped after ${QUERY_TIMEOUT_MS / 1000} s`,
};
