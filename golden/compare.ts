import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CONTEXTS } from '../shared/api.ts';
import { OUT_DIR, REPORT_NAME, type GoldenReport } from './report.ts';

type Report = GoldenReport & { file: string };

function load(file: string): Report {
  return { ...(JSON.parse(readFileSync(file, 'utf8')) as GoldenReport), file };
}

function latestPerSetAndArm(): string[] {
  if (!existsSync(OUT_DIR)) return [];
  const latest = new Map<string, Report>();
  for (const name of readdirSync(OUT_DIR).filter((n) => REPORT_NAME.test(n))) {
    const report = load(join(OUT_DIR, name));
    const key = `${report.set}/${report.arm}`;
    const current = latest.get(key);
    if (!current || report.date > current.date) latest.set(key, report);
  }
  return [...latest.values()].map((r) => r.file);
}

const majority = (passes: number, runs: number) => passes * 2 > runs;

type Flips = { up: string[]; down: string[] };

function flips(from: Report, to: Report): Flips {
  const target = new Map(to.results.map((r) => [r.id, r]));
  const up: string[] = [];
  const down: string[] = [];
  for (const before of from.results) {
    const after = target.get(before.id);
    if (!after) continue;
    const was = majority(before.passes, from.runs);
    const is = majority(after.passes, to.runs);
    if (!was && is) up.push(before.id);
    if (was && !is) down.push(before.id);
  }
  return { up, down };
}

function setSection(set: string, reports: readonly Report[]): string[] {
  const columns = CONTEXTS.flatMap((arm) => reports.filter((r) => r.arm === arm).map((r) => [arm, r] as const));
  const ids = [...new Set(reports.flatMap((r) => r.results.map((q) => q.id)))];
  const checks = new Map(reports.flatMap((r) => r.results.map((q) => [q.id, q.check] as const)));
  const row = (cell: (r: Report) => string) => columns.map(([, r]) => cell(r)).join(' | ');
  const lines = [
    `## ${set} set`,
    '',
    ...columns.map(([arm, r]) => `- ${arm}: ${basename(r.file)} · ${r.runs} run(s) · ${r.models_served.join(', ') || '(no model)'} · fingerprint ${r.dataset.fingerprint}`),
    '',
    `| Question | Check | ${columns.map(([arm]) => arm).join(' | ')} |`,
    `| --- | --- | ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const id of ids) {
    lines.push(`| ${id} | ${checks.get(id)} | ${row((r) => {
      const q = r.results.find((x) => x.id === id);
      return q ? `${q.passes}/${r.runs}` : '-';
    })} |`);
  }
  lines.push(`| **total runs passed** | | ${row((r) => `${r.results.reduce((sum, q) => sum + q.passes, 0)}/${r.results.length * r.runs}`)} |`);
  lines.push(`| **questions passed (majority of runs)** | | ${row((r) => `${r.results.filter((q) => majority(q.passes, r.runs)).length}/${r.results.length}`)} |`);

  lines.push('', 'Flips (a question passes an arm when it passes a majority of its runs):', '', '| From → to | fail→pass | pass→fail | Questions |', '| --- | --- | --- | --- |');
  columns.forEach(([fromArm, from], i) => {
    for (const [toArm, to] of columns.slice(i + 1)) {
      const { up, down } = flips(from, to);
      const named = [...up.map((id) => `+${id}`), ...down.map((id) => `-${id}`)].join(', ') || '-';
      lines.push(`| ${fromArm} → ${toArm} | ${up.length} | ${down.length} | ${named} |`);
    }
  });
  return lines;
}

function main(argv: readonly string[]): number {
  const files = argv.length > 0 ? argv.map((f) => resolve(f)) : latestPerSetAndArm();
  if (files.length === 0) {
    console.error(`No reports in ${OUT_DIR}. Run npm run golden first.`);
    return 1;
  }
  const reports = files.map(load);
  const sets = [...new Set(reports.map((r) => r.set))];
  const duplicates = sets.flatMap((set) => CONTEXTS.filter((arm) => reports.filter((r) => r.set === set && r.arm === arm).length > 1).map((arm) => `${set}-${arm}`));
  if (duplicates.length > 0) {
    console.error(`More than one report given for ${duplicates.join(', ')}; pass one file per set and arm.`);
    return 2;
  }
  const output = sets.flatMap((set) => [...setSection(set, reports.filter((r) => r.set === set)), '']);
  console.log(output.join('\n'));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
