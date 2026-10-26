/** 从 fetch Response 中解析 SSE 流，逐条产出 data 负载（自动跨 chunk 拼接） */
export async function* sseData(res: Response, signal?: AbortSignal, maxBytes?: number): AsyncGenerator<string> {
  if (!res.body) throw new Error('响应无 body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (maxBytes !== undefined && received > maxBytes) throw new Error('模型流超过子任务响应字节预算');
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload.length > 0) yield payload;
        }
        // 忽略注释行/空行/event:/id: 等字段
      }
    }
  } finally {
    if (maxBytes !== undefined) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 从错误响应中提取可读信息 */
export async function readHttpError(res: Response, maxBytes?: number): Promise<string> {
  let detail = '';
  try {
    let text = '';
    if (maxBytes === undefined) text = await res.text();
    else if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let remaining = Math.min(8192, maxBytes);
      try {
        while (remaining > 0) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value.subarray(0, remaining), { stream: true });
          remaining -= value.byteLength;
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    detail = text.slice(0, 500);
  } catch {
    // ignore
  }
  return `HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`;
}
