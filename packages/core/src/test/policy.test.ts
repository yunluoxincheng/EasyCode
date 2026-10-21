import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type DecisionPolicy,
  type DecisionRequest,
  type DecisionResult,
  runAgentLoop,
  ToolRegistry,
  MemoryHost,
  ApprovalManager
} from '../index.js';
import type { ChatMessage, Provider, StreamRequest } from '../index.js';

test('runAgentLoop 容忍 policy 内部抛出异常，主循环平滑执行', async () => {
  const host = new MemoryHost({ '/w/file.txt': 'hello' });
  const tools = new ToolRegistry();
  const approval = new ApprovalManager(() => {}, 'yolo');
  const controller = new AbortController();

  let policyCalls = 0;
  const failingPolicy: DecisionPolicy = {
    async decide(_req: DecisionRequest): Promise<DecisionResult> {
      policyCalls++;
      throw new Error('Policy execution failed simulated');
    },
  };

  const mockProvider: Provider = {
    id: 'mock',
    async stream(_req: StreamRequest) {
      return {
        blocks: [{ type: 'text', text: 'Done without tools' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };

  const messages: ChatMessage[] = [{ role: 'user', content: 'Say hello' }];
  const res = await runAgentLoop({
    provider: mockProvider,
    tools,
    host,
    workspace: '/w',
    systemPrompt: 'System',
    messages,
    signal: controller.signal,
    approval,
    emit: () => {},
    policy: failingPolicy,
  });

  assert.equal(res.reason, 'completed');
  assert.equal(messages.length, 2);
  assert.equal(policyCalls, 2, '推理档位与前置工具路由旁路异常均不阻断主循环');
});
