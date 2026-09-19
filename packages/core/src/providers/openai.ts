import type { AssistantBlock, ChatMessage, ToolCallBlock } from '../types.js';
import type { StreamRequest, Provider, TurnResult, StreamContext } from './index.js';
import { sseData, readHttpError } from './sse.js';

/* ---------------- 内部格式 → OpenAI wire 格式 ---------------- */

function toWireMessages(messages: ChatMessage[]) {
  const wire: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      wire.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const text = msg.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = msg.blocks.filter((b) => b.type === 'tool_call');
      const entry: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((c) => {
          const call = c as ToolCallBlock;
          return {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          };
        });
      }
      wire.push(entry);
    } else {
      wire.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }
  return wire;
}

/* ---------------- 流式解析 ---------------- */

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly config: { baseURL: string; apiKey?: string; model: string },
  ) {}

  async stream(request: StreamRequest, ctx: StreamContext): Promise<TurnResult> {
    const url = joinUrl(this.config.baseURL, 'chat/completions');
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        ...toWireMessages(request.messages),
      ],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
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
    const pendingTools = new Map<number, PendingToolCall>();
    let usage: TurnResult['usage'];
    let stopReason: string | undefined;

    for await (const payload of sseData(res, ctx.signal)) {
      if (payload === '[DONE]') break;
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        textParts.push(choice.delta.content);
        ctx.emit({ type: 'text_delta', delta: choice.delta.content });
      }
      if (choice?.delta?.reasoning_content) {
        thinkingParts.push(choice.delta.reasoning_content);
        ctx.emit({ type: 'reasoning_delta', delta: choice.delta.reasoning_content });
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const slot = pendingTools.get(index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        pendingTools.set(index, slot);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }

    const blocks: AssistantBlock[] = [];
    if (thinkingParts.length > 0) blocks.push({ type: 'thinking', text: thinkingParts.join('') });
    if (textParts.length > 0) blocks.push({ type: 'text', text: textParts.join('') });
    const toolIds = new Set<string>();
    for (const [, slot] of [...pendingTools.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {};
      if (slot.arguments.trim()) {
        try {
          input = JSON.parse(slot.arguments);
        } catch {
          input = { _raw: slot.arguments, _parse_error: true };
        }
      }
      const call: ToolCallBlock = {
        type: 'tool_call',
        id: slot.id || `call_${toolIds.size}_${Date.now().toString(36)}`,
        name: slot.name || 'unknown',
        input,
      };
      toolIds.add(call.id);
      blocks.push(call);
    }
    return { blocks, usage, stopReason };
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.endsWith('/') ? base + suffix : `${base}/${suffix}`;
}
