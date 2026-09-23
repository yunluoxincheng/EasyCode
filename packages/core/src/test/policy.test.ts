import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NoopDecisionPolicy,
  type DecisionPolicy,
  type DecisionRequest,
  type DecisionResult,
  runAgentLoop,
  ToolRegistry,
  MemoryHost,
  ApprovalManager,
} from '../index.js';
import type { ChatMessage, Provider, StreamRequest } from '../index.js';

test('NoopDecisionPolicy 默认选择首项、标记 defer 并均分概率', async () => {
  const policy = new NoopDecisionPolicy();
  const req: DecisionRequest = {
    instruction: 'Choose next action',
    state: { summary: 'Clean git repo' },
    candidates: [
      { id: 'c1', text: 'Action 1' },
      { id: 'c2', text: 'Action 2' },
    ],
  };

  const res = await policy.decide(req);
  assert.equal(res.selectedId, 'c1');
  assert.equal(res.selectedText, 'Action 1');
  assert.equal(res.defer, true);
  assert.equal(res.confidence, 0);
  assert.equal(res.latencyMs, 0);
  assert.equal(res.scores.c1, 0.5);
  assert.equal(res.scores.c2, 0.5);
});

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
  assert.equal(policyCalls, 2, 'reasoning_effort 与 information_sufficiency 决策点被触发过 2 次');
});
