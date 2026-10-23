import type { AgentEvent } from './events.js';

export interface UserQuestion {
  id: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
}

export interface UserAnswer {
  questionId: string;
  selectedOption?: string;
  text?: string;
}

export interface UserQuestionRequest {
  requestId: string;
  callId: string;
  questions: UserQuestion[];
}

export interface UserQuestionResult {
  kind: 'user_question_result';
  requestId: string;
  status: 'answered' | 'cancelled';
  answers: UserAnswer[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('问题或回答必须是对象');
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name}不能为空，且长度不得超过 ${max} 字符`);
  }
  return value.trim();
}

/** 模型输入与历史回放共用边界；始终允许选项之外的自由文本。 */
export function parseUserQuestions(input: unknown): UserQuestion[] {
  const raw = record(typeof input === 'string' ? JSON.parse(input) : input).questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error('每次请提出 1–3 个相关问题');
  const seen = new Set<string>();
  return raw.map((value) => {
    const item = record(value);
    const id = text(item.id, 64, '问题 ID');
    if (!/^[\w-]+$/.test(id) || seen.has(id)) throw new Error('问题 ID 必须唯一，且仅包含字母、数字、下划线或连字符');
    seen.add(id);
    const question = text(item.question, 1200, '问题');
    let options: UserQuestion['options'];
    if (item.options !== undefined && !(Array.isArray(item.options) && item.options.length === 0)) {
      if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6) {
        throw new Error('选项须为 2–6 项；自由文本问题请省略 options 或使用空数组');
      }
      const labels = new Set<string>();
      options = item.options.map((value) => {
        const option = record(value);
        const label = text(option.label, 160, '选项');
        if (labels.has(label)) throw new Error('同一问题中的选项不能重复');
        labels.add(label);
        const description = option.description === undefined || (typeof option.description === 'string' && !option.description.trim())
          ? undefined : text(option.description, 500, '选项说明');
        return { label, ...(description ? { description } : {}) };
      });
    }
    return { id, question, ...(options ? { options } : {}) };
  });
}

export function parseUserAnswers(questions: UserQuestion[], input: unknown): UserAnswer[] {
  if (!Array.isArray(input) || input.length !== questions.length) throw new Error('请回答本次提问中的每一个问题');
  const seen = new Set<string>();
  return input.map((value) => {
    const raw = record(value);
    const questionId = text(raw.questionId, 64, '问题 ID');
    const question = questions.find((question) => question.id === questionId);
    if (!question || seen.has(questionId)) throw new Error('回答的问题 ID 不匹配或重复');
    seen.add(questionId);
    const selectedOption = raw.selectedOption === undefined ? undefined : text(raw.selectedOption, 160, '所选选项');
    if (selectedOption && !question.options?.some((option) => option.label === selectedOption)) {
      throw new Error('所选选项不属于该问题');
    }
    const answerText = raw.text === undefined || (typeof raw.text === 'string' && !raw.text.trim()) ? undefined : text(raw.text, 4000, '回答');
    if (!selectedOption && !answerText) throw new Error('请选择选项或填写自己的回答');
    return { questionId, ...(selectedOption ? { selectedOption } : {}), ...(answerText ? { text: answerText } : {}) };
  });
}

/** 独立于审批模式：只有实际提交的回答能完成等待，YOLO 没有代答入口。 */
export class UserQuestionManager {
  private pending = new Map<string, { request: UserQuestionRequest; settle(result: UserQuestionResult): void }>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  getPending(): UserQuestionRequest | null {
    const request = this.pending.values().next().value?.request;
    return request ? structuredClone(request) : null;
  }

  request(callId: string, input: unknown, signal: AbortSignal): Promise<UserQuestionResult> {
    signal.throwIfAborted();
    if (this.pending.size) throw new Error('当前已有等待回答的问题');
    const request: UserQuestionRequest = {
      requestId: `uq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`,
      callId,
      questions: parseUserQuestions(input),
    };
    return new Promise((resolve) => {
      const onAbort = () => { this.cancel(request.requestId); };
      // 先登记再派发，允许同进程宿主在事件回调中同步提交或停止。
      this.pending.set(request.requestId, { request, settle: (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      } });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      try { this.emit({ type: 'question_request', request: structuredClone(request) }); }
      catch { this.cancel(request.requestId); }
    });
  }

  respond(requestId: string, answers: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('问题已过期或已提交，请勿重复回答');
    this.finish(requestId, 'answered', parseUserAnswers(pending.request.questions, answers));
  }

  cancel(requestId: string): boolean {
    return this.finish(requestId, 'cancelled', []);
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  private finish(requestId: string, status: UserQuestionResult['status'], answers: UserAnswer[]): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    const result: UserQuestionResult = { kind: 'user_question_result', requestId, status, answers };
    pending.settle(structuredClone(result));
    try { this.emit({ type: 'question_resolved', callId: pending.request.callId, result: structuredClone(result) }); }
    catch { /* 派发失败不能重新打开已收敛的等待。 */ }
    return true;
  }
}
