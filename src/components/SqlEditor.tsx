import { PostgreSQL, sql } from '@codemirror/lang-sql';
import CodeMirror, { keymap, Prec } from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { COLUMNS, TABLE } from '../../shared/schema';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeToScheme(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const prefersDark = () => window.matchMedia(DARK_QUERY).matches;

const schemaCompletion = sql({
  dialect: PostgreSQL,
  defaultTable: TABLE,
  schema: {
    [TABLE]: COLUMNS.map((c) => ({ label: c.name, type: 'property', detail: c.type, info: c.description })),
  },
});

type Props = {
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  canRun: boolean;
  readOnly: boolean;
  verdict: ReactNode;
  children?: ReactNode;
};

export function SqlEditor({ value, onChange, onRun, canRun, readOnly, verdict, children }: Props) {
  const dark = useSyncExternalStore(subscribeToScheme, prefersDark);
  const runRef = useRef(onRun);
  useEffect(() => {
    runRef.current = onRun;
  });

  const extensions = useMemo(
    () => [
      schemaCompletion,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              runRef.current();
              return true;
            },
          },
        ]),
      ),
    ],
    [],
  );

  return (
    <section className="panel">
      <div className="row between">
        <div className="row">
          <label htmlFor="sql-editor">SQL</label>
          {verdict}
        </div>
        <button type="button" onClick={onRun} disabled={!canRun} title="Run (Cmd/Ctrl+Enter)">
          Run ▶
        </button>
      </div>
      <CodeMirror
        id="sql-editor"
        className="editor"
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        extensions={extensions}
        theme={dark ? 'dark' : 'light'}
        minHeight="120px"
        basicSetup={{ foldGutter: false }}
        aria-label="SQL"
      />
      {children}
    </section>
  );
}
