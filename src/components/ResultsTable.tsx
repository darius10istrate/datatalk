import type { Result } from '../../shared/pipeline';
import { resultMessage } from '../state';

export function AskingBar({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="row" role="status">
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <span className="muted">Asking…</span>
    </div>
  );
}

export function RunningBar({ seconds, onCancel }: { seconds: number; onCancel: () => void }) {
  return (
    <div className="row" role="status">
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <span className="muted">Running… {seconds.toFixed(1)} s</span>
    </div>
  );
}

export function ResultsTable({ result }: { result: Result }) {
  const summary = <p className="muted">{`${resultMessage(result)} · ${result.ms} ms`}</p>;
  if (result.rows.length === 0) return summary;
  return (
    <>
      {summary}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} className={c.numeric ? 'num' : undefined}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className={result.columns[j]?.numeric ? 'num' : undefined}>
                    {cell === null ? <span className="muted">NULL</span> : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
