import { fmt, loadingMessage, MESSAGES, type AppState } from '../state';

export function StatusBar({ state, rows, drift }: { state: AppState; rows: number | null; drift: readonly string[] }) {
  return (
    <>
      <header className="status">
        <span>
          NYC Yellow Taxi · January 2024{rows !== null && <> · {fmt(rows)} trips</>}
        </span>
        {state.phase === 'loading' && (
          <span className="muted" role="status">
            {loadingMessage(state.progress)}
          </span>
        )}
        {state.phase === 'load_failed' && (
          <span className="err" role="alert">
            Load failed: {state.message}
          </span>
        )}
        {rows !== null && <span className="ok">● {MESSAGES.ready}</span>}
      </header>
      {drift.length > 0 && (
        <div className="banner" role="alert">
          <strong>{MESSAGES.drift}</strong>
          <ul>
            {drift.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <span className="muted">Queries still run.</span>
        </div>
      )}
    </>
  );
}
