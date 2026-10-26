import type { AssistantBlock, ChatMessage, ToolCallBlock } from '../types.js';
import type { StreamRequest, Provider, TurnResult, StreamContext } from './index.js';
import { sseData, readHttpError } from './sse.js';

/* ---------------- 内部格式 → Responses API wire 格式 ---------------- */

type WireInputItem = Record<string, unknown>;

function toWireInput(messages: ChatMessage[]): WireInputItem[] {
  const input: WireInputItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: msg.content }] });
    } else if (msg.role === 'assistant') {
      for (const b of msg.blocks) {
        if (b.type === 'text' && b.text) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: b.text }] });
        } else if (b.type === 'tool_call') {
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
        // thinking 块不回传（Responses API 要求原生 reasoning item，无法伪造）
      }
    } else {
      input.push({ type: 'function_call_output', call_id: msg.toolCallId, output: msg.content });
    }
  }
  return input;
}

/**
 * OpenAI Responses API 适配器（/responses）。
 * 文本/思考实时流出；工具调用从 response.completed 的 output 数组取全量。
 */
export class ResponsesProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly config: { baseURL: string; apiKey?: string; model: string; nativeWebSearch?: boolean },
  ) {}

  async stream(request: StreamRequest, ctx: StreamContext): Promise<TurnResult> {
    const url = joinUrl(this.config.baseURL, 'responses');
    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      input: toWireInput(request.messages),
    };
    if (request.system) body.instructions = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }
    // 原生联网搜索：服务端工具，结果由 API 自行执行并注入（web_search_call 输出项在解析时被忽略）
    if (this.config.nativeWebSearch) {
      body.tools = [...((body.tools as unknown[]) ?? []), { type: 'web_search' }];
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`Provider 请求失败: ${await readHttpError(res, ctx.maxResponseBytes)}`);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    let usage: TurnResult['usage'];
    let toolCalls: ToolCallBlock[] = [];
    type Preparing = { callId: string; name: string; argumentChars: number; argumentsComplete: boolean; emittedAt: number };
    const preparing = new Map<string, Preparing>();
    const byIndex = new Map<number, Preparing>();
    const streamAbort = new AbortController();
    const onAbort = () => streamAbort.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    let lastProgress = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let stallError: Error | undefined;
    let completed = false;
    const progress = (start = false) => {
      lastProgress = Date.now();
      if (start && watchdog === undefined) watchdog = setInterval(() => {
        if (Date.now() - lastProgress >= 120_000) {
          stallError = new Error('工具调用生成连续 120 秒没有有效进展，已停止本次响应；未执行未完成的工具调用。可稍后重试或切换模型。');
          streamAbort.abort();
        }
      }, 1000);
    };
    const publish = (tool: Preparing, force = false) => {
      if (!force && Date.now() - tool.emittedAt < 250) return;
      tool.emittedAt = Date.now();
      ctx.emit({ type: 'tool_call_preparing', callId: tool.callId, name: tool.name,
        argumentChars: tool.argumentChars, argumentsComplete: tool.argumentsComplete });
    };

    type WireEvent = {
      type: string;
      delta?: string;
      item_id?: string;
      output_index?: number;
      arguments?: string;
      message?: string;
      code?: string;
      error?: { message?: string; code?: string };
      item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string };
      response?: {
        status?: string;
        error?: { message?: string; code?: string } | null;
        incomplete_details?: { reason?: string } | null;
        output?: Array<{
          type: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
    };

    try {
      for await (const payload of sseData(res, streamAbort.signal, ctx.maxResponseBytes)) {
        let evt: WireEvent;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (!evt || typeof evt !== 'object') continue;
        if (['response.failed', 'response.incomplete', 'response.cancelled', 'error'].includes(evt.type)) {
          const detail = evt.response?.error?.message ?? evt.response?.incomplete_details?.reason ?? evt.error?.message ?? evt.message ?? evt.code ?? evt.type;
          throw new Error(`模型响应未成功完成（${evt.type}）：${String(detail).slice(0, 500)}；未执行本响应的工具调用。`);
        }
        if (evt.type === 'response.output_item.added' && evt.item?.type === 'function_call' &&
            typeof evt.item.call_id === 'string' && typeof evt.item.name === 'string' &&
            evt.item.call_id && evt.item.name && !preparing.has(evt.item.call_id)) {
          const tool: Preparing = { callId: evt.item.call_id, name: evt.item.name,
            argumentChars: evt.item.arguments?.length ?? 0, argumentsComplete: false, emittedAt: 0 };
          preparing.set(evt.item.call_id, tool);
          if (evt.item.id) preparing.set(evt.item.id, tool);
          if (typeof evt.output_index === 'number') byIndex.set(evt.output_index, tool);
          progress(true);
          publish(tool, true);
        } else if (evt.type === 'response.function_call_arguments.delta' || evt.type === 'response.function_call_arguments.done') {
          const tool = (evt.item_id ? preparing.get(evt.item_id) : undefined) ??
            (typeof evt.output_index === 'number' ? byIndex.get(evt.output_index) : undefined);
          if (!tool) continue;
          if (evt.type.endsWith('.delta') && typeof evt.delta === 'string' && evt.delta.length && !tool.argumentsComplete) {
            tool.argumentChars += evt.delta.length;
            progress();
            publish(tool);
          } else if (evt.type.endsWith('.done') && !tool.argumentsComplete && typeof evt.arguments === 'string') {
            tool.argumentChars = evt.arguments.length;
            tool.argumentsComplete = true;
            progress();
            publish(tool, true);
          }
        } else if (evt.type === 'response.output_text.delta' && evt.delta) {
          progress();
          textParts.push(evt.delta);
          ctx.emit({ type: 'text_delta', delta: evt.delta });
        } else if (
          (evt.type === 'response.reasoning_text.delta' ||
            evt.type === 'response.reasoning_summary_text.delta') &&
          evt.delta
        ) {
          progress();
          thinkingParts.push(evt.delta);
          ctx.emit({ type: 'reasoning_delta', delta: evt.delta });
        } else if (evt.type === 'response.completed') {
          if (!Array.isArray(evt.response?.output) || evt.response.error ||
              (evt.response.status !== undefined && evt.response.status !== 'completed')) {
            throw new Error('模型完成事件缺少有效的完整结果，未执行工具调用。');
          }
          usage = evt.response?.usage
            ? {
                inputTokens: evt.response.usage.input_tokens,
                outputTokens: evt.response.usage.output_tokens,
                cachedTokens: evt.response.usage.input_tokens_details?.cached_tokens,
              }
            : undefined;
          toolCalls = evt.response.output
            .filter((item) => item.type === 'function_call' && item.name)
            .map((item) => {
              if (typeof item.arguments !== 'string' || !item.arguments.trim()) {
                throw new Error('模型返回的工具参数必须是非空 JSON 字符串，未执行工具调用。');
              }
              let input: unknown;
              try {
                input = JSON.parse(item.arguments);
              } catch {
                throw new Error('模型返回的工具参数不是完整 JSON，未执行工具调用。');
              }
              return {
                type: 'tool_call',
                id: item.call_id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
                name: item.name ?? 'unknown',
                input,
              } satisfies ToolCallBlock;
            });
          const returned = new Set(toolCalls.map((call) => call.id));
          if ([...preparing.values()].some((tool) => !returned.has(tool.callId))) {
            throw new Error('模型完成结果缺少已声明的工具调用，未执行工具调用。');
          }
          completed = true;
          break;
        }
      }
      if (!completed) throw new Error('模型流已结束，但未收到 response.completed 完成确认；未执行本响应的工具调用。');
    } catch (error) {
      if (stallError && !ctx.signal.aborted) throw stallError;
      throw error;
    } finally {
      clearInterval(watchdog);
      ctx.signal.removeEventListener('abort', onAbort);
    }

    const blocks: AssistantBlock[] = [];
    if (thinkingParts.length > 0) blocks.push({ type: 'thinking', text: thinkingParts.join('') });
    if (textParts.length > 0) blocks.push({ type: 'text', text: textParts.join('') });
    blocks.push(...toolCalls);
    return {
      blocks,
      usage,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
    };
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.endsWith('/') ? base + suffix : `${base}/${suffix}`;
}
