import test from 'node:test';
import assert from 'node:assert/strict';
import { todoWriteTool } from '../tools/todo.js';
import { MemoryHost } from '../host.js';

const mockCtx = {
  host: new MemoryHost(),
  workspace: '/workspace',
  signal: new AbortController().signal,
};

test('todoWriteTool正常执行并格式化输出', async () => {
  const result = await todoWriteTool.execute(
    {
      todos: [
        { content: '需求梳理', status: 'completed' },
        { content: '核心逻辑实现', status: 'in_progress', priority: 'high' },
        { content: '单元测试编写', status: 'pending', priority: 'medium' },
      ],
    },
    mockCtx,
  );

  assert.match(result, /共 3 项：已完成 1 项，进行中 1 项，待办 1 项/);
  assert.match(result, /\[✓\] 1\. 需求梳理/);
  assert.match(result, /\[◍\] 2\. 核心逻辑实现 \[HIGH\]/);
  assert.match(result, /\[○\] 3\. 单元测试编写 \[MEDIUM\]/);
});

test('todoWriteTool拦截多个in_progress', async () => {
  await assert.rejects(
    () =>
      todoWriteTool.execute(
        {
          todos: [
            { content: '任务1', status: 'in_progress' },
            { content: '任务2', status: 'in_progress' },
          ],
        },
        mockCtx,
      ),
    /至多只能有 1 个任务处于 in_progress/
  );
});

test('todoWriteTool拦截非法状态和空content', async () => {
  await assert.rejects(
    () =>
      todoWriteTool.execute(
        {
          todos: [{ content: '', status: 'pending' }],
        },
        mockCtx,
      ),
    /content 必须为非空字符串/
  );

  await assert.rejects(
    () =>
      todoWriteTool.execute(
        {
          todos: [{ content: '有效任务', status: 'invalid_status' as any }],
        },
        mockCtx,
      ),
    /状态非法/
  );
});
