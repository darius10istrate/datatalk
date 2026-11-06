import { useState } from 'react';
import { MAX_QUESTION_LENGTH } from '../../shared/api';

export function QuestionBox({ enabled, asking, onAsk }: { enabled: boolean; asking: boolean; onAsk: (question: string) => void }) {
  const [question, setQuestion] = useState('');
  const canAsk = enabled && question.trim() !== '';

  return (
    <form
      className="panel question"
      onSubmit={(e) => {
        e.preventDefault();
        if (canAsk) onAsk(question.trim());
      }}
    >
      <label htmlFor="question">Question</label>
      <div className="row">
        <input
          id="question"
          type="text"
          value={question}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder="Which borough had the highest average tip?"
          autoComplete="off"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" disabled={!canAsk} aria-busy={asking}>
          {asking ? (
            <>
              <span className="spinner" aria-hidden="true" /> Asking…
            </>
          ) : (
            'Ask'
          )}
        </button>
      </div>
    </form>
  );
}
