export type LoadProgress =
  | { stage: 'engine' }
  | { stage: 'data'; loaded: number; total: number }
  | { stage: 'lock' };
