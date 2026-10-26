/** 只读子任务协议；过程不属于父模型消息，宿主负责执行与留档。 */
export interface DelegatedTaskInput {
  description: string;
  hints?: string;
  return_format?: string;
}

export interface DelegatedTaskRunner {
  run(call: { id: string; messageId: string }, input: DelegatedTaskInput, signal: AbortSignal): Promise<string>;
}

export interface DelegatedTaskTrace {
  kind: 'text' | 'thinking' | 'tool' | 'result' | 'error';
  content: string;
  at: number;
  tool?: string;
}

export interface DelegatedTaskRecord {
  id: string;
  parentCallId: string;
  parentMessageId: string;
  parentUserMessageId: string;
  description: string;
  status: 'running' | 'completed' | 'aborted' | 'error';
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  trace: DelegatedTaskTrace[];
  traceTruncated?: boolean;
  /** 冷恢复时确认中断，不以停机时间推算执行耗时。 */
  recovered?: boolean;
  usage: { input: number; output: number; cached: number; steps: number };
}

export function parseDelegatedTask(input: unknown): DelegatedTaskInput {
  if (typeof input === 'string') input = JSON.parse(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('子任务参数必须是对象');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['description', 'hints', 'return_format'].includes(key))) {
    throw new Error('只读子任务仅接受 description、hints 与 return_format');
  }
  const text = (key: string, limit: number, required = false): string | undefined => {
    const value = raw[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${key} 必须为 1–${limit} 字符的文本`);
    return value.trim();
  };
  return { description: text('description', 4000, true)!, hints: text('hints', 2000), return_format: text('return_format', 1000) };
}
