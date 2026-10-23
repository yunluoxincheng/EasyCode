import { useState } from 'react';
import { parseUserAnswers, type UserAnswer } from '@easycode/core';
import type { QuestionItem } from '../store.js';
import { useStoreApi } from '../useStore.js';

/** 问答独立于审批卡片，选项不预选，任何问题均保留自由文本入口。 */
export function QuestionCard({ item }: { item: QuestionItem }) {
  const store = useStoreApi();
  const sessionId = store.activeId;
  const [draft, setDraft] = useState<UserAnswer[]>(() => item.draft ?? []);
  const [submitting, setSubmitting] = useState(false);
  const pending = item.status === 'pending';
  let valid = false;
  try { parseUserAnswers(item.questions, draft); valid = true; } catch { /* 未填写不算回答。 */ }

  const update = (questionId: string, patch: Partial<UserAnswer>) => {
    const next = draft.filter((answer) => answer.questionId !== questionId);
    next.push({ ...draft.find((answer) => answer.questionId === questionId), questionId, ...patch });
    if (sessionId) store.saveQuestionDraft(sessionId, item.requestId, next);
    setDraft(next);
  };
  const submit = async () => {
    if (!sessionId || !pending || submitting || !valid) return;
    setSubmitting(true);
    try { await store.respondQuestion(sessionId, item.requestId, parseUserAnswers(item.questions, draft)); }
    finally { setSubmitting(false); }
  };
  const cancel = async () => {
    if (!sessionId || !pending || submitting) return;
    setSubmitting(true);
    try { await store.cancelQuestion(sessionId, item.requestId); }
    finally { setSubmitting(false); }
  };
  const status = pending ? '[ WAIT ] 等待你的回答' : item.status === 'answered' ? '[ OK ] 已回答' : item.status === 'cancelled' ? '[ STOP ] 已取消' : '[ EXPIRED ] 提问已失效';

  return <section className={`question-card ${item.status}`} aria-label="用户提问">
    <div className="question-head" role="status">{status}</div>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {item.questions.map((question) => {
        const answer = (pending ? draft : item.answers)?.find((answer) => answer.questionId === question.id);
        return <fieldset key={question.id} className="question-field" disabled={!pending || submitting}>
          <legend>{question.question}</legend>
          {pending ? <>
            {question.options?.map((option) => <label className="question-option" key={option.label}>
              <input type="radio" name={`${item.id}-${question.id}`} checked={answer?.selectedOption === option.label}
                onChange={() => update(question.id, { selectedOption: option.label })} />
              <span><strong>{option.label}</strong>{option.description && <span className="question-description">{option.description}</span>}</span>
            </label>)}
            {answer?.selectedOption && <button type="button" className="btn" onClick={() => update(question.id, { selectedOption: undefined })}>清除选择</button>}
            <label className="question-text-label">
              {question.options ? '自己的回答或补充意见' : '你的回答'}
              <textarea rows={2} maxLength={4000} value={answer?.text ?? ''}
                onChange={(event) => update(question.id, { text: event.target.value })} />
            </label>
          </> : <div className="question-answer" tabIndex={0}>
            {answer?.selectedOption && <strong>{answer.selectedOption}</strong>}
            {answer?.text && <p>{answer.text}</p>}
            {!answer && <span>此提问已结束，不能再提交。</span>}
          </div>}
        </fieldset>;
      })}
      {pending && <div className="question-actions">
        <span>提交后继续当前任务；YOLO 不会替你回答。</span>
        <button type="button" className="btn" disabled={submitting} onClick={() => void cancel()}>取消并停止</button>
        <button type="submit" className="btn primary" disabled={!valid || submitting}>{submitting ? '正在提交' : '提交回答并继续'}</button>
      </div>}
    </form>
  </section>;
}
