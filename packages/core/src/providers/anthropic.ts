import type { AssistantBlock, ChatMessage, ToolCallBlock } from '../types.js';
import type { StreamRequest, Provider, TurnResult, StreamContext } from './index.js';
import { sseData, readHttpError } from './sse.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const MAX_TOKENS = 8192;

/* ---------------- 内部格式 → Anthropic wire 格式 ---------------- */

export function toWireMessages(messages: ChatMessage[]) {
  const wire: Record<string, unknown>[] = [];
  let expectedToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'user') {
      expectedToolCallIds.clear();
      wire.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
    } else if (msg.role === 'assistant') {
      expectedToolCallIds.clear();
      const content: Record<string, unknown>[] = [];
      for (const b of msg.blocks) {
        if (b.type === 'text') {
          content.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking') {
          // Anthropic 官方要求 thinking block 必须带有合法的服务端签名。
          // 跨厂商（如 DeepSeek/GLM）切换时无此签名，直接回传会导致 400 校验失败，因此清洗过滤
        } else if (b.type === 'tool_call') {
          const call = b as ToolCallBlock;
          expectedToolCallIds.add(call.id);
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
        }
      }
      if (content.length === 0) {
        content.push({ type: 'text', text: '' });
      }
      wire.push({ role: 'assistant', content });
    } else {
      // tool_result 归并为相邻 user 消息（Anthropic 要求 tool_result 在 user 消息内）
      // 仅当属于当前预期的 tool_use_id 时处理，杜绝孤儿 tool_result
      const last = wire[wire.length - 1];
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      if (last && last.role === 'user' && !last._hasText) {
        (last.content as unknown[]).push(block);
      } else {
        wire.push({ role: 'user', content: [block], _hasText: false });
      }
      expectedToolCallIds.delete(msg.toolCallId);
    }
  }
  return wire.map(({ _hasText, ...rest }) => rest);
}

export class AnthropicProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly config: {
      baseURL?: string;
      apiKey?: string;
      model: string;
      nativeWebSearch?: boolean;
    },
  ) {}

  async stream(request: StreamRequest, ctx: StreamContext): Promise<TurnResult> {
    const base = this.config.baseURL?.trim() || DEFAULT_BASE;
    const url = `${base.replace(/\/$/, '')}/v1/messages`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: toWireMessages(request.messages),
    };
    if (request.system) body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    // 原生联网搜索：Anthropic 服务端工具（server_tool_use 块在解析时被忽略）
    if (this.config.nativeWebSearch) {
      body.tools = [...((body.tools as unknown[]) ?? []), { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`Provider 请求失败: ${await readHttpError(res)}`);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const tools = new Map<string, { id: string; name: string; json: string }>();
    let usage: TurnResult['usage'];

    type WireEvent = {
      type: string;
      index?: number;
      content_block?: { type: string; id?: string; name?: string };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        stop_reason?: string;
      };
      message?: {
        usage?: { input_tokens?: number; cache_read_input_tokens?: number };
      };
      usage?: { output_tokens?: number };
    };

    for await (const payload of sseData(res, ctx.signal)) {
      let evt: WireEvent;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === 'message_start') {
        usage = {
          inputTokens: evt.message?.usage?.input_tokens,
          cachedTokens: evt.message?.usage?.cache_read_input_tokens,
        };
      } else if (evt.type === 'content_block_delta') {
        if (evt.delta?.type === 'text_delta' && evt.delta.text) {
          textParts.push(evt.delta.text);
          ctx.emit({ type: 'text_delta', delta: evt.delta.text });
        } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
          thinkingParts.push(evt.delta.thinking);
          ctx.emit({ type: 'reasoning_delta', delta: evt.delta.thinking });
        } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
          const slot = tools.get(String(evt.index));
          if (slot) slot.json += evt.delta.partial_json;
        }
      } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        tools.set(String(evt.index), {
          id: evt.content_block.id ?? `tu_${evt.index}`,
          name: evt.content_block.name ?? 'unknown',
          json: '',
        });
      } else if (evt.type === 'message_delta') {
        if (evt.usage?.output_tokens !== undefined) {
          usage = { ...(usage ?? {}), outputTokens: evt.usage.output_tokens };
        }
      }
    }

    const blocks: AssistantBlock[] = [];
    if (thinkingParts.length > 0) blocks.push({ type: 'thinking', text: thinkingParts.join('') });
    if (textParts.length > 0) blocks.push({ type: 'text', text: textParts.join('') });
    for (const [, slot] of [...tools.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      let input: unknown = {};
      if (slot.json.trim()) {
        try {
          input = JSON.parse(slot.json);
        } catch {
          input = { _raw: slot.json, _parse_error: true };
        }
      }
      blocks.push({ type: 'tool_call', id: slot.id, name: slot.name, input });
    }
    return { blocks, usage, stopReason: blocks.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end_turn' };
  }
}
