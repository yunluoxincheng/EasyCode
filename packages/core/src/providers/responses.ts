import type { AssistantBlock, ChatMessage, ToolCallBlock, Usage } from '../types.js';
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
    private readonly config: { baseURL: string; apiKey?: string; model: string },
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

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`Provider 请求失败: ${await readHttpError(res)}`);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    let usage: TurnResult['usage'];
    let toolCalls: ToolCallBlock[] = [];

    type WireEvent = {
      type: string;
      delta?: string;
      response?: {
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

    for await (const payload of sseData(res, ctx.signal)) {
      let evt: WireEvent;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === 'response.output_text.delta' && evt.delta) {
        textParts.push(evt.delta);
        ctx.emit({ type: 'text_delta', delta: evt.delta });
      } else if (
        (evt.type === 'response.reasoning_text.delta' ||
          evt.type === 'response.reasoning_summary_text.delta') &&
        evt.delta
      ) {
        thinkingParts.push(evt.delta);
        ctx.emit({ type: 'reasoning_delta', delta: evt.delta });
      } else if (evt.type === 'response.completed') {
        usage = evt.response?.usage
          ? {
              inputTokens: evt.response.usage.input_tokens,
              outputTokens: evt.response.usage.output_tokens,
              cachedTokens: evt.response.usage.input_tokens_details?.cached_tokens,
            }
          : undefined;
        toolCalls = (evt.response?.output ?? [])
          .filter((item) => item.type === 'function_call' && item.name)
          .map((item) => {
            let input: unknown = {};
            if (item.arguments && item.arguments.trim()) {
              try {
                input = JSON.parse(item.arguments);
              } catch {
                input = { _raw: item.arguments, _parse_error: true };
              }
            }
            return {
              type: 'tool_call',
              id: item.call_id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
              name: item.name ?? 'unknown',
              input,
            } satisfies ToolCallBlock;
          });
      }
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
